/**
 * Transformer Model — simulates audio transformer characteristics:
 *
 * 1. LF coupling: High-pass filter models finite primary inductance
 *    that rolls off low frequencies.
 * 2. Core saturation: Flux-based B-H curve model. Real transformer
 *    cores see magnetic flux (∫V dt), not voltage directly. Low
 *    frequencies accumulate more flux per cycle, producing the
 *    frequency-dependent saturation characteristic of iron/nickel cores.
 *    Generates even harmonics from B-H curve asymmetry.
 * 3. HF resonant rolloff: Low-pass filter with adjustable Q models
 *    leakage inductance resonating with distributed winding capacitance.
 */

import {
  BiquadFilter,
  designHighpass,
  designLowpass,
} from './biquad';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface TransformerOptions {
  /** LF coupling frequency in Hz (default: 20) */
  lfCutoff?: number;
  /** HF resonant rolloff frequency in Hz, clamped to 0.45*fs (default: 50000) */
  hfResonance?: number;
  /** Q of HF resonance (default: 0.8) */
  hfQ?: number;
  /** Core saturation drive — scales operating flux relative to Bs (default: 1.0) */
  satAmount?: number;
  /** Even-harmonic asymmetry from remanent magnetization / DC bias in core.
   *  Higher = more even harmonics. Jensen ≈ 0.005, Haufe ≈ 0.015, generic ≈ 0.03.
   *  (default: 0.015) */
  asymmetry?: number;
}

export class TransformerModel {
  private readonly hpf: BiquadFilter;
  private readonly lpf: BiquadFilter;
  private satGain: number;
  private readonly sampleRate: number;

  // Eddy current loss: first-order lowpass modeling frequency-dependent
  // losses in the transformer core (proportional to f²). The cutoff is
  // set below the leakage resonance to provide a gentle progressive rolloff
  // before the sharper resonant LPF kicks in.
  private eddyZ1 = 0;
  private readonly eddyCoeff: number;

  // Store current options for partial reconfigure
  private currentLfCutoff: number;
  private currentHfResonance: number;
  private currentHfQ: number;

  // Flux-based core saturation state
  //
  // Physics: B = Bs * tanh(Φ * K), where Φ = ∫V dt
  // Output voltage V_out ∝ dB/dt (Faraday's law)
  //
  // coreStiffness K scales flux into the nonlinear region of tanh.
  // Derived from core geometry: K ∝ N / (Bs * A_core)
  // Tuned so that at 100 Hz, nominal signal level (0.5), and satGain=1,
  // the core operates at tanh(~0.5) — mild, audible saturation on LF content.
  private flux = 0;
  private prevBout = 0;
  private readonly coreStiffness: number;
  private readonly fluxDecay: number;
  private asymmetry: number;

  constructor(sampleRate: number, options?: TransformerOptions) {
    this.sampleRate = sampleRate;
    this.currentLfCutoff = clamp(options?.lfCutoff ?? 20, 1, 0.45 * sampleRate);
    this.currentHfResonance = clamp(options?.hfResonance ?? 50000, 10, 0.45 * sampleRate);
    this.currentHfQ = clamp(options?.hfQ ?? 0.8, 0.1, 8);
    this.satGain = clamp(options?.satAmount ?? 1.0, 0, 4);
    this.asymmetry = clamp(options?.asymmetry ?? 0.015, -0.2, 0.2);

    // HPF at lfCutoff, Q=0.5 — models LF coupling from finite primary inductance
    this.hpf = new BiquadFilter(designHighpass(this.currentLfCutoff, sampleRate, 0.5));

    // LPF at hfResonance, Q=hfQ — models HF rolloff with resonant peak
    this.lpf = new BiquadFilter(designLowpass(this.currentHfResonance, sampleRate, this.currentHfQ));

    // First-order LP at ~35 kHz for eddy current losses.
    // Eddy currents in the laminated core cause frequency-dependent loss
    // proportional to f². A first-order LP is a simple approximation that
    // provides a gentle, progressive HF attenuation before the resonant LPF.
    const eddyCutoff = Math.min(35000, 0.4 * sampleRate);
    this.eddyCoeff = Math.exp(-2 * Math.PI * eddyCutoff / sampleRate);

    // Core stiffness: K = 2π * f_ref where f_ref is the frequency at which
    // a unit-amplitude signal produces unit normalized flux in the tanh argument.
    // At 80 Hz reference, K ≈ 500. This means:
    //   - 80 Hz, A=0.5, satGain=1 → tanh argument ≈ 0.5 (mild saturation)
    //   - 1 kHz, A=0.5, satGain=1 → tanh argument ≈ 0.04 (nearly linear)
    //   - 40 Hz, A=0.5, satGain=1 → tanh argument ≈ 1.0 (significant saturation)
    // This frequency-dependent behavior is physically correct.
    this.coreStiffness = 2 * Math.PI * 80;

    // Flux DC leak: prevents numerical drift in the integrator.
    // Time constant of 10 seconds — far below audio frequencies,
    // so it doesn't affect the signal, only prevents runaway.
    this.fluxDecay = 1 - 1 / (sampleRate * 10);
  }

  /** Compute core B value from the current flux for continuity-safe reconfiguration. */
  private computeBout(flux: number, satGain: number, asymmetry: number): number {
    if (satGain <= 0.001) return 0;
    const phi = flux * satGain * this.coreStiffness;
    let Bout = Math.tanh(phi);
    Bout += asymmetry * phi / (1 + phi * phi);
    return Bout;
  }

  /**
   * Process a single sample through the transformer model.
   *
   * Signal chain: HPF -> Core Saturation (flux-based) -> LPF
   */
  process(input: number): number {
    // 1. HPF (LF coupling — finite primary inductance)
    let x = this.hpf.process(input);

    // 2. Flux-based core saturation
    // Always maintain flux state so transitions in/out of saturation are clean
    const T = 1 / this.sampleRate;
    this.flux = this.flux * this.fluxDecay + x * T;
    if (!Number.isFinite(this.flux)) {
      this.flux = 0;
      this.prevBout = 0;
    }

    if (this.satGain > 0.001) {
      // Scale flux into B-H curve operating region
      // satGain represents how close to core saturation we operate:
      //   satGain=0: linear (no core nonlinearity)
      //   satGain=1: nominal operating point (mild LF saturation)
      //   satGain=2: hot level, significant LF compression + harmonics
      const phi = this.flux * this.satGain * this.coreStiffness;

      // B-H curve: tanh models the anhysteretic magnetization curve
      // of soft magnetic materials (mu-metal, silicon steel, nickel)
      let Bout = Math.tanh(phi);

      // Even-harmonic asymmetry from remanent magnetization / DC bias
      // in real cores. Bounded term prevents runaway at extreme phi.
      Bout += this.asymmetry * phi / (1 + phi * phi);

      // Faraday's law: V_out ∝ dB/dt
      const dBdt = (Bout - this.prevBout) * this.sampleRate;
      this.prevBout = Bout;

      // Normalize: at small signals, tanh(phi) ≈ phi, so the chain
      // integrate → identity → differentiate gives back x scaled by
      // (satGain * coreStiffness). Divide out for unity small-signal gain.
      x = dBdt / (this.satGain * this.coreStiffness);
    } else {
      // Saturation bypassed — keep prevBout at 0 so re-enabling starts clean
      this.prevBout = 0;
    }

    // 3. Eddy current losses (first-order LP — progressive HF attenuation)
    this.eddyZ1 = x + this.eddyCoeff * (this.eddyZ1 - x);
    x = this.eddyZ1;

    // 4. LPF (HF rolloff — leakage inductance + winding capacitance resonance)
    x = this.lpf.process(x);

    // Fail-safe: never let NaN/Infinity poison downstream chain.
    if (!Number.isFinite(x)) {
      this.reset();
      return 0;
    }

    return x;
  }

  /** Reconfigure transformer parameters. Only updates fields present in options. */
  reconfigure(options: TransformerOptions): void {
    let nonlinearityChanged = false;
    if (options.satAmount !== undefined) {
      const sat = clamp(options.satAmount, 0, 4);
      if (sat !== this.satGain) {
        this.satGain = sat;
        nonlinearityChanged = true;
      }
    }
    if (options.asymmetry !== undefined) {
      const asym = clamp(options.asymmetry, -0.2, 0.2);
      if (asym !== this.asymmetry) {
        this.asymmetry = asym;
        nonlinearityChanged = true;
      }
    }

    // Keep dB/dt continuous when nonlinear parameters change.
    // Without this, large satAmount jumps can produce an impulse.
    if (nonlinearityChanged) {
      this.prevBout = this.computeBout(this.flux, this.satGain, this.asymmetry);
    }

    let filtersChanged = false;
    if (options.lfCutoff !== undefined) {
      this.currentLfCutoff = clamp(options.lfCutoff, 1, 0.45 * this.sampleRate);
      filtersChanged = true;
    }
    if (options.hfResonance !== undefined) {
      this.currentHfResonance = clamp(options.hfResonance, 10, 0.45 * this.sampleRate);
      filtersChanged = true;
    }
    if (options.hfQ !== undefined) {
      this.currentHfQ = clamp(options.hfQ, 0.1, 8);
      filtersChanged = true;
    }
    if (filtersChanged) {
      this.hpf.updateCoeffs(designHighpass(this.currentLfCutoff, this.sampleRate, 0.5));
      this.lpf.updateCoeffs(designLowpass(this.currentHfResonance, this.sampleRate, this.currentHfQ));
    }
  }

  /** Reset all internal state. */
  reset(): void {
    this.hpf.reset();
    this.lpf.reset();
    this.flux = 0;
    this.prevBout = 0;
    this.eddyZ1 = 0;
  }
}
