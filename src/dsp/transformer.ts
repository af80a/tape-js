/**
 * Implicit Nonlinear Transformer Model
 *
 * Uses a Newton-Raphson ODE solver to model the transformer primary as a truly
 * continuous analog circuit: V_in = I(Φ)*R + dΦ/dt
 *
 * 1. Dynamic LF Thinning: HPF is not a static digital filter. It emerges naturally
 *    from the solver. As flux (Φ) enters saturation, the required current I(Φ) spikes,
 *    causing the inductor to drop voltage and dynamically shift the cutoff frequency
 *    upward. This physically starves the core of bass during massive transients.
 * 2. Infinite Stability: The implicit Trapezoidal solver is unconditionally A-stable.
 *    It cannot blow up, requires no artificial clipping limits, and eliminates the
 *    1-sample delay phase warping of explicit feed-forward models.
 * 3. Hysteresis-like Asymmetry: Modeled as a quadratic current draw, creating
 *    even harmonics without offsetting the DC resting state.
 */

import { BiquadFilter, designLowpass } from "./biquad";

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
  /** Core saturation drive (default: 1.0). 0 = perfectly linear. */
  satAmount?: number;
  /** Even-harmonic asymmetry. (default: 0.015) */
  asymmetry?: number;
  /** Input gain applied before the ODE (linear, default: 1.0).
   *  Scales how much flux the core accumulates — more gain = more
   *  frequency-selective LF saturation without changing the core's
   *  nonlinear characteristic (satAmount). */
  inputGain?: number;
}

export class TransformerModel {
  private readonly sampleRate: number;
  private readonly T: number;

  // Implicit ODE State
  private flux = 0;
  private vL = 0; // Voltage across the primary inductor (the output of the saturation stage)

  // ODE Coefficients
  private k1 = 0;
  private k2 = 0;
  private k3 = 0;
  private currentWlf = 0; // Omega of LF cutoff
  private readonly coreStiffness: number;

  // Downstream Linear Components
  private readonly lpf: BiquadFilter;
  private eddyZ1 = 0;
  private readonly eddyCoeff: number;

  // Options State
  private currentLfCutoff: number;
  private currentHfResonance: number;
  private currentHfQ: number;
  private satGain: number;
  private asymmetry: number;
  private inputGain: number;

  constructor(sampleRate: number, options?: TransformerOptions) {
    this.sampleRate = sampleRate;
    this.T = 1.0 / sampleRate;

    this.currentLfCutoff = clamp(options?.lfCutoff ?? 20, 1, 0.45 * sampleRate);
    this.currentHfResonance = clamp(
      options?.hfResonance ?? 50000,
      10,
      0.45 * sampleRate,
    );
    this.currentHfQ = clamp(options?.hfQ ?? 0.8, 0.1, 8);
    this.satGain = clamp(options?.satAmount ?? 1.0, 0, 4);
    this.asymmetry = clamp(options?.asymmetry ?? 0.015, -0.2, 0.2);
    this.inputGain = clamp(options?.inputGain ?? 1.0, 0.25, 4.0);

    // K scales the flux. Tuned so nominal flux hits ~1.0 at 80 Hz.
    this.coreStiffness = 2 * Math.PI * 80;

    // LPF at hfResonance, Q=hfQ — models HF rolloff with resonant peak
    this.lpf = new BiquadFilter(
      designLowpass(this.currentHfResonance, sampleRate, this.currentHfQ),
    );

    // First-order LP for eddy current losses
    const eddyCutoff = Math.min(35000, 0.4 * sampleRate);
    this.eddyCoeff = Math.exp((-2 * Math.PI * eddyCutoff) / sampleRate);

    this.updateOdeCoeffs();
  }

  /**
   * Pre-calculates the coefficients for the nonlinear current polynomial:
   * I(Φ) * R = ω_LF * Φ * [ 1 + a*(K*Φ) + b*(K*Φ)^2 ]
   *
   * The Φ*(1 + ...) form guarantees I(0)=0. With a=0, the symmetric case
   * b*(KΦ)^2 is the leading-order Taylor expansion of cosh²(KΦ), which is
   * the exact current-flux inversion of a tanh B-H curve.
   * Asymmetry (a≠0) tilts the curve to generate even harmonics.
   */
  private updateOdeCoeffs(): void {
    this.currentWlf = 2.0 * Math.PI * this.currentLfCutoff;

    const a = this.asymmetry;
    let b = this.satGain;

    // Mathematical safety: ensure F'(Φ) = 3k3Φ² + 2k2Φ + k1 > 0 for all Φ (monotonic cubic).
    // The exact condition is k2² < 3*k3*k1. Since k1 is dominated by 2/T (>>ω_LF),
    // this is much more lenient than the normalized form, but enforcing b > a²/3
    // is a simple, conservative bound that always satisfies it.
    const minB = (a * a) / 3.0;
    if (b < minB && (b > 0 || a !== 0)) {
      b = minB + 0.001; // Force monotonicity if asymmetry demands it
    }

    // k1 = ω_LF + 2/T  (The linear HPF term + Trapezoidal integration term)
    this.k1 = this.currentWlf + 2.0 / this.T;

    // k2 = ω_LF * K * a (Quadratic asymmetry term)
    this.k2 = this.currentWlf * this.coreStiffness * a;

    // k3 = ω_LF * K^2 * b (Cubic saturation term)
    this.k3 = this.currentWlf * this.coreStiffness * this.coreStiffness * b;
  }

  process(input: number): number {
    // 1. IMPLICIT NONLINEAR ODE SOLVER (Core Saturation & Dynamic HPF)
    //
    // Equation: V_in = I(Φ)*R + V_L
    // Where V_L = dΦ/dt
    // Discretized via Trapezoidal rule.

    // C is the constant part of the Trapezoidal equation for the current time step
    const C = input * this.inputGain + (2.0 / this.T) * this.flux + this.vL;

    let phi = this.flux; // Initial guess for Newton-Raphson

    if (this.k3 === 0 && this.k2 === 0) {
      // Fast path: perfectly linear (satAmount = 0, asymmetry = 0)
      // This collapses exactly into a pristine digital 1-pole HPF.
      phi = C / this.k1;
    } else {
      // Newton-Raphson Iteration (4 passes is sufficient for a monotonic cubic)
      for (let i = 0; i < 4; i++) {
        const phi2 = phi * phi;
        const phi3 = phi2 * phi;

        // F(Φ) = k3*Φ^3 + k2*Φ^2 + k1*Φ - C = 0
        const F = this.k3 * phi3 + this.k2 * phi2 + this.k1 * phi - C;

        // Derivative F'(Φ)
        const dF = 3.0 * this.k3 * phi2 + 2.0 * this.k2 * phi + this.k1;

        // Update guess
        phi -= F / dF;
      }
    }

    // Anti-denormal for the state variable
    if (Math.abs(phi) < 1e-12) phi = 0;

    // Extract the resulting output voltage (V_L = dΦ/dt)
    let vOut = (2.0 / this.T) * (phi - this.flux) - this.vL;
    if (Math.abs(vOut) < 1e-12) vOut = 0;

    // Update continuous states
    this.flux = phi;
    this.vL = vOut;

    let x = vOut;

    // 2. Eddy current losses (first-order LP)
    this.eddyZ1 = x + this.eddyCoeff * (this.eddyZ1 - x);
    if (Math.abs(this.eddyZ1) < 1e-12) this.eddyZ1 = 0;
    x = this.eddyZ1;

    // 3. LPF (HF rolloff / resonant peak)
    x = this.lpf.process(x);

    // Fail-safe protection downstream
    if (!Number.isFinite(x) || Math.abs(x) > 50) {
      this.reset();
      return 0;
    }

    return x;
  }

  reconfigure(options: TransformerOptions): void {
    let updateOde = false;
    let updateLpf = false;

    if (options.lfCutoff !== undefined) {
      this.currentLfCutoff = clamp(options.lfCutoff, 1, 0.45 * this.sampleRate);
      updateOde = true;
    }
    if (options.satAmount !== undefined) {
      this.satGain = clamp(options.satAmount, 0, 4);
      updateOde = true;
    }
    if (options.asymmetry !== undefined) {
      this.asymmetry = clamp(options.asymmetry, -0.2, 0.2);
      updateOde = true;
    }
    if (options.inputGain !== undefined) {
      this.inputGain = clamp(options.inputGain, 0.25, 4.0);
    }

    if (options.hfResonance !== undefined) {
      this.currentHfResonance = clamp(
        options.hfResonance,
        10,
        0.45 * this.sampleRate,
      );
      updateLpf = true;
    }
    if (options.hfQ !== undefined) {
      this.currentHfQ = clamp(options.hfQ, 0.1, 8);
      updateLpf = true;
    }

    if (updateOde) this.updateOdeCoeffs();
    if (updateLpf) {
      this.lpf.updateCoeffs(
        designLowpass(
          this.currentHfResonance,
          this.sampleRate,
          this.currentHfQ,
        ),
      );
    }
  }

  reset(): void {
    this.lpf.reset();
    this.flux = 0;
    this.vL = 0;
    this.eddyZ1 = 0;
  }

  /**
   * Returns 0-1 indicating how deep the core is into saturation.
   * Based on the instantaneous drop in differential permeability.
   */
  getSaturationDepth(): number {
    if (this.satGain <= 0.001 && this.asymmetry === 0) return 0;

    // I'(Φ) represents the inverse of permeability.
    // When unsaturated, I'(Φ) = ω_LF.
    // When saturated, it spikes rapidly.
    const dI_dPhi =
      this.currentWlf +
      2.0 * this.k2 * this.flux +
      3.0 * this.k3 * (this.flux * this.flux);

    // Ratio maps [ω_LF ... ∞] to [0 ... 1]
    const depth = 1.0 - this.currentWlf / dI_dPhi;
    return clamp(depth, 0, 1);
  }
}
