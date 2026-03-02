/**
 * Tape head frequency-response model.
 *
 * Models four phenomena:
 * 1. Head bump — a low-frequency resonance peak whose frequency
 *    scales with tape speed.
 * 2. Head-bump dip — a slight dip at twice the bump frequency.
 * 3. Gap loss — sinc(π * g * f / v) rolloff from the finite width
 *    of the playback head gap.
 * 4. Spacing loss — exp(-2π * d * f / v) exponential HF loss from
 *    the head-to-tape air gap (Wallace equation).
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
  private readonly tapeSpeedIps: number;

  // FIR loss filter state
  private lossKernel: Float64Array;
  private lossState: Float64Array;
  private readonly lossOrder: number;

  /**
   * @param sampleRate    Audio sample rate in Hz
   * @param tapeSpeedIps  Tape speed in inches per second (e.g. 15)
   * @param options       Gap width and spacing for loss filter
   */
  constructor(sampleRate: number, tapeSpeedIps: number, options?: HeadLossOptions) {
    this.sampleRate = sampleRate;
    this.tapeSpeedIps = tapeSpeedIps;
    this.lossOrder = LOSS_FIR_ORDER;
    const maxFreq = 0.45 * sampleRate;

    // Head bump: peaking boost at tapeSpeed * 3.67 Hz
    // Bump frequency derives from pole piece contact length: f = v / (2*L).
    // The constant 3.67 Hz/ips corresponds to L ≈ 3.5 mm pole piece length.
    const bumpFreq = Math.min(tapeSpeedIps * 3.67, maxFreq);
    const bumpGainDb = options?.bumpGainDb ?? 3.0;

    // Bump Q scales with tape speed: lower speeds produce broader bumps
    // because the wavelength interaction with the pole piece is less selective.
    // Q ≈ 1.0 + (speed/30) * 1.5 gives:
    //   7.5 ips → Q ≈ 1.375 (broad)
    //   15 ips  → Q ≈ 1.75
    //   30 ips  → Q ≈ 2.5 (narrow)
    const bumpQ = 1.0 + (tapeSpeedIps / 30) * 1.5;
    this.bump = new BiquadFilter(
      designPeaking(bumpFreq, sampleRate, bumpGainDb, bumpQ),
    );

    // Dip at twice the bump frequency (when wavelength = pole piece length,
    // positive and negative half-cycles cancel). Dip Q also scales with speed.
    const dipFreq = Math.min(bumpFreq * 2, maxFreq);
    const dipQ = 1.0 + (tapeSpeedIps / 30) * 0.8;
    this.dip = new BiquadFilter(
      designPeaking(dipFreq, sampleRate, -1.5, dipQ),
    );

    // FIR loss filter: sinc gap loss + exponential spacing loss
    const gapWidth = options?.gapWidth ?? 2e-6;
    const spacing = options?.spacing ?? 0.5e-6;
    this.lossKernel = new Float64Array(2 * this.lossOrder + 1);
    this.lossState = new Float64Array(2 * this.lossOrder + 1);
    this.computeLossKernel(gapWidth, spacing);
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

  /** Process a single sample: bump -> dip -> FIR loss filter. */
  process(input: number): number {
    let y = this.bump.process(input);
    y = this.dip.process(y);

    // FIR loss filter (direct convolution with delay line)
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
    const maxFreq = 0.45 * this.sampleRate;
    const bumpFreq = Math.min(this.tapeSpeedIps * 3.67, maxFreq);
    const bumpQ = 1.0 + (this.tapeSpeedIps / 30) * 1.5;
    this.bump.updateCoeffs(designPeaking(bumpFreq, this.sampleRate, gainDb, bumpQ));
  }

  /** Reset all internal filter states. */
  reset(): void {
    this.bump.reset();
    this.dip.reset();
    this.lossState.fill(0);
  }
}
