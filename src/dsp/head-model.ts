/**
 * Tape head frequency-response model.
 *
 * Models five phenomena:
 * 1. Head bump — a low-frequency resonance peak whose frequency
 *    scales with tape speed (biquad peaking filter, per ChowTape/DAFx 2019).
 * 2. Head-bump dip — a slight dip at twice the bump frequency.
 * 3. Gap loss — sinc(π * g * f / v) rolloff from the finite width
 *    of the playback head gap.
 * 4. Spacing loss — exp(-2π * d * f / v) exponential HF loss from
 *    the head-to-tape air gap (Wallace equation).
 * 5. Dynamic spacing modulation from dropouts — momentary increases in
 *    head-to-tape spacing from coating defects or debris, modeled via the
 *    Wallace equation with a single spacing parameter d(t) driving both
 *    gain loss and HF rolloff.
 *
 * The gap + spacing losses are combined into a short FIR filter whose
 * coefficients are computed from the sampled frequency response via
 * inverse DCT.
 */

import { BiquadFilter, designPeaking } from './biquad';

export interface HeadLossOptions {
  /** Playback head gap width in meters (default: 2e-6 = 2 µm). */
  gapWidth?: number;
  /** Head-to-tape spacing in meters (default: 0.5e-6 = 0.5 µm). */
  spacing?: number;
  /** Head bump boost in dB (default: 3.0). */
  bumpGainDb?: number;
}

// Default FIR filter order (taps = 2*ORDER+1)
const LOSS_FIR_ORDER = 32;

export class HeadModel {
  private bump: BiquadFilter;
  private dip: BiquadFilter;
  private readonly sampleRate: number;
  private tapeSpeedIps: number;

  // FIR loss filter state
  private lossKernel: Float64Array;
  private lossState: Float64Array;
  private readonly lossOrder: number;

  // Options cache
  private readonly gapWidth: number;
  private readonly spacing: number;
  private bumpGainDb: number;

  // Stochastic dropout state
  // All driven by a single physical variable: instantaneous head-to-tape spacing d(t).
  // The Hanning-windowed spacing profile drives both broadband gain loss and
  // HF rolloff via the Wallace spacing loss equation.
  private dropoutActive = false;
  private dropoutDuration = 0;
  private dropoutTime = 0;
  private dropoutIntensity = 0.0;
  // Peak spacing increase in meters during a dropout event.
  // Typical tape lift-off from particles: 1-25 µm.
  private dropoutPeakSpacing = 0;
  // Smoothed instantaneous spacing for the Wallace LPF (avoids clicks)
  private dropoutSpacing = 0;
  private dropoutLpfState = 0;

  // Per-instance xorshift32 PRNG for dropout randomness.
  // Avoids global this.nextRandom() which couples channels' dropout sequences.
  private prngState: number;

  /**
   * @param sampleRate    Audio sample rate in Hz
   * @param tapeSpeedIps  Tape speed in inches per second (e.g. 15)
   * @param options       Gap width and spacing for loss filter
   * @param seed          PRNG seed for dropout randomness (use channel index)
   */
  constructor(sampleRate: number, tapeSpeedIps: number, options?: HeadLossOptions, seed = 0) {
    this.prngState = 1 + seed * 65537;
    this.sampleRate = sampleRate;
    this.tapeSpeedIps = tapeSpeedIps;
    this.lossOrder = LOSS_FIR_ORDER;

    this.gapWidth = options?.gapWidth ?? 2e-6;
    this.spacing = options?.spacing ?? 0.5e-6;
    this.bumpGainDb = options?.bumpGainDb ?? 3.0;

    const maxFreq = 0.45 * sampleRate;

    // Head bump: peaking boost at tapeSpeed * 3.67 Hz
    // Bump frequency derives from pole piece contact length: f = v / (2*L).
    // The constant 3.67 Hz/ips corresponds to L ≈ 3.5 mm pole piece length.
    const bumpFreq = Math.min(tapeSpeedIps * 3.67, maxFreq);

    // Bump Q scales with tape speed: lower speeds produce broader bumps
    // because the wavelength interaction with the pole piece is less selective.
    // Q ≈ 1.0 + (speed/30) * 1.5 gives:
    //   7.5 ips → Q ≈ 1.375 (broad)
    //   15 ips  → Q ≈ 1.75
    //   30 ips  → Q ≈ 2.5 (narrow)
    const bumpQ = 1.0 + (tapeSpeedIps / 30) * 1.5;
    this.bump = new BiquadFilter(
      designPeaking(bumpFreq, sampleRate, this.bumpGainDb, bumpQ),
    );

    // Dip at twice the bump frequency (when wavelength = pole piece length,
    // positive and negative half-cycles cancel). Dip Q also scales with speed.
    const dipFreq = Math.min(bumpFreq * 2, maxFreq);
    const dipQ = 1.0 + (tapeSpeedIps / 30) * 0.8;
    this.dip = new BiquadFilter(
      designPeaking(dipFreq, sampleRate, -1.5, dipQ),
    );

    // FIR loss filter: sinc gap loss + exponential spacing loss
    this.lossKernel = new Float64Array(2 * this.lossOrder + 1);
    this.lossState = new Float64Array(2 * this.lossOrder + 1);
    this.computeLossKernel(this.gapWidth, this.spacing);
  }

  /** Update tape speed, recalculating filters dynamically */
  setSpeed(tapeSpeedIps: number): void {
    if (this.tapeSpeedIps === tapeSpeedIps) return;
    this.tapeSpeedIps = tapeSpeedIps;

    const maxFreq = 0.45 * this.sampleRate;
    const bumpFreq = Math.min(tapeSpeedIps * 3.67, maxFreq);
    const bumpQ = 1.0 + (tapeSpeedIps / 30) * 1.5;
    this.bump.updateCoeffs(designPeaking(bumpFreq, this.sampleRate, this.bumpGainDb, bumpQ));

    const dipFreq = Math.min(bumpFreq * 2, maxFreq);
    const dipQ = 1.0 + (tapeSpeedIps / 30) * 0.8;
    this.dip.updateCoeffs(designPeaking(dipFreq, this.sampleRate, -1.5, dipQ));

    this.computeLossKernel(this.gapWidth, this.spacing);
  }

  /**
   * Compute the FIR loss filter kernel from gap width and spacing.
   *
   * 1. Sample the combined frequency response H(f) = sinc(π*g*f/v) * exp(-2π*d*f/v)
   * 2. Convert to time-domain FIR via inverse DCT
   * 3. Apply Blackman window and normalize for unity DC gain
   */
  private computeLossKernel(gapWidth: number, spacing: number): void {
    const N = 2 * this.lossOrder + 1;
    const tapeSpeedMps = this.tapeSpeedIps * 0.0254; // inches/sec to meters/sec
    const nyquist = this.sampleRate / 2;

    // Number of frequency bins for response computation
    const numBins = 256;

    // Sample the combined loss frequency response
    const H = new Float64Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const f = (k / (numBins - 1)) * nyquist;

      // Gap loss: sinc(π * g * f / v)
      let gapLoss = 1.0;
      if (gapWidth > 0 && f > 0) {
        const arg = Math.PI * gapWidth * f / tapeSpeedMps;
        gapLoss = arg > 1e-10 ? Math.sin(arg) / arg : 1.0;
        // Take absolute value: the sinc function goes negative past the null,
        // but in practice the response is the magnitude
        gapLoss = Math.abs(gapLoss);
      }

      // Spacing loss: exp(-2π * d * f / v) (Wallace equation)
      let spacingLoss = 1.0;
      if (spacing > 0 && f > 0) {
        spacingLoss = Math.exp(-2 * Math.PI * spacing * f / tapeSpeedMps);
      }

      H[k] = gapLoss * spacingLoss;
    }

    // Inverse DTFT to get FIR coefficients (symmetric/linear-phase)
    // h[n] = (1/(K-1)) * Σ H[k] * cos(ω_k * (n - mid))
    // where ω_k = π * k / (K-1) spans 0 to π (DC to Nyquist)
    const mid = this.lossOrder;
    const kernel = this.lossKernel;
    for (let n = 0; n < N; n++) {
      let sum = 0;
      for (let k = 0; k < numBins; k++) {
        const w = Math.PI * k / (numBins - 1); // angular freq: 0..π
        sum += H[k] * Math.cos(w * (n - mid));
      }
      kernel[n] = sum / (numBins - 1);
    }

    // Apply Blackman window
    for (let n = 0; n < N; n++) {
      const w = 0.42
        - 0.5 * Math.cos(2 * Math.PI * n / (N - 1))
        + 0.08 * Math.cos(4 * Math.PI * n / (N - 1));
      kernel[n] *= w;
    }

    // Normalize for unity DC gain
    let dcGain = 0;
    for (let n = 0; n < N; n++) {
      dcGain += kernel[n];
    }
    if (Math.abs(dcGain) > 1e-15) {
      const scale = 1 / dcGain;
      for (let n = 0; n < N; n++) {
        kernel[n] *= scale;
      }
    }
  }

  /** Process a single sample: dynamic spacing -> bump -> dip -> FIR loss filter. */
  process(input: number, extraSpacing = 0): number {
    const tapeSpeedMps = this.tapeSpeedIps * 0.0254;

    // --- Stochastic Dropouts ---
    // Tape momentarily lifts off the head due to coating defects or particles.
    // A single physical variable — instantaneous spacing d(t) — drives both
    // broadband attenuation and HF rolloff via the Wallace equation.
    if (this.dropoutIntensity > 0 && !this.dropoutActive) {
      // Probability per sample: at max intensity, ~once per 4 seconds at 48kHz
      if (this.nextRandom() < 5e-6 * this.dropoutIntensity) {
        this.dropoutActive = true;
        // Duration: 1-15ms typical (IEC 60094), up to 30ms at max intensity
        const minDur = 0.001;
        const maxDur = 0.005 + 0.025 * this.dropoutIntensity;
        this.dropoutDuration = (minDur + this.nextRandom() * (maxDur - minDur)) * this.sampleRate;
        this.dropoutTime = 0;
        // Peak spacing: 2-25 µm, scaled by intensity
        this.dropoutPeakSpacing = (2e-6 + this.nextRandom() * 23e-6 * this.dropoutIntensity);
      }
    }

    // Compute instantaneous dropout spacing from Hanning envelope
    let targetSpacing = Math.max(0, extraSpacing);
    if (this.dropoutActive) {
      this.dropoutTime++;
      if (this.dropoutTime >= this.dropoutDuration) {
        this.dropoutActive = false;
      } else {
        const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.dropoutTime / this.dropoutDuration);
        targetSpacing += this.dropoutPeakSpacing * env;
      }
    }

    // Smooth spacing transitions (τ ≈ 0.5ms to prevent clicks)
    const spacingSmoothAlpha = Math.exp(-1 / (this.sampleRate * 0.0005));
    this.dropoutSpacing = this.dropoutSpacing * spacingSmoothAlpha + targetSpacing * (1 - spacingSmoothAlpha);

    let y = input;

    // Apply Wallace-equation-derived dropout effects when spacing is significant
    if (this.dropoutSpacing > 1e-8) {
      const d = this.dropoutSpacing;

      // Broadband attenuation at a reference frequency (1 kHz).
      // Wallace: loss = exp(-2π * d * f / v)
      const refFreq = 1000;
      const broadbandGain = Math.exp(-2 * Math.PI * d * refFreq / tapeSpeedMps);
      y *= broadbandGain;

      // Dynamic LPF: the -3dB cutoff from the Wallace equation is
      // f_3dB = v * ln(2) / (2π * d)
      const cutoff = Math.min(
        tapeSpeedMps * 0.6931 / (2 * Math.PI * d),
        this.sampleRate * 0.45,
      );
      const alpha = Math.exp(-2 * Math.PI * cutoff / this.sampleRate);
      this.dropoutLpfState = this.dropoutLpfState * alpha + y * (1 - alpha);
      y = this.dropoutLpfState;
    } else {
      // Track the signal to prevent click when a dropout begins
      this.dropoutLpfState = y;
    }

    // --- Head bump + dip (biquad peaking filters) ---
    y = this.bump.process(y);
    y = this.dip.process(y);

    // --- FIR loss filter (direct convolution with delay line) ---
    const N = this.lossKernel.length;
    const state = this.lossState;
    const kernel = this.lossKernel;

    // Shift delay line right
    for (let j = N - 1; j > 0; j--) {
      state[j] = state[j - 1];
    }
    state[0] = y;

    // Dot product with kernel
    let sum = 0;
    for (let j = 0; j < N; j++) {
      sum += state[j] * kernel[j];
    }

    return sum;
  }

  /** Update the head bump gain in dB (range -6 to +6). */
  setBumpGain(gainDb: number): void {
    this.bumpGainDb = gainDb;
    const maxFreq = 0.45 * this.sampleRate;
    const bumpFreq = Math.min(this.tapeSpeedIps * 3.67, maxFreq);
    const bumpQ = 1.0 + (this.tapeSpeedIps / 30) * 1.5;
    this.bump.updateCoeffs(designPeaking(bumpFreq, this.sampleRate, gainDb, bumpQ));
  }

  /** Update dropout intensity (0 = off, 1 = max). */
  setDropoutIntensity(intensity: number): void {
    this.dropoutIntensity = intensity;
  }

  /** Xorshift32 PRNG returning a value in [0, 1). */
  private nextRandom(): number {
    let x = this.prngState | 0;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.prngState = x;
    return ((x >>> 0) / 0xFFFFFFFF);
  }

  /** Reset all internal filter states. */
  reset(): void {
    this.bump.reset();
    this.dip.reset();
    this.lossState.fill(0);
    this.dropoutSpacing = 0;
    this.dropoutLpfState = 0;
    this.dropoutActive = false;
  }
}
