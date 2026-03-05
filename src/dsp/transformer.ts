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
  private K_eff = 0;  // Effective core stiffness: coreStiffness * sqrt(satAmount)
  private currentWlf = 0; // Omega of LF cutoff
  private readonly coreStiffness: number;

  // Saturation depth cached inside the Newton loop — getSaturationDepth() is free (no extra exp).
  private _cachedSatDepth = 0;

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
   * Pre-calculates the effective core stiffness for the cosh² nonlinear model:
   * I(Φ) * R = ω_LF * Φ * cosh²(K_eff*Φ) * (1 + a*K_eff*Φ)
   *
   * cosh²(KΦ) is the exact current-flux inversion of a tanh B-H curve
   * (Jiles-Atherton framework). It grows exponentially near saturation,
   * naturally bounding flux without any hard clamp.
   * The (1 + a*K_eff*Φ) tilt produces even harmonics while preserving I(0)=0.
   *
   * K_eff = coreStiffness * sqrt(satAmount).
   * When satAmount = 0, K_eff = 0, cosh²(0) = 1 → perfectly linear.
   */
  private updateOdeCoeffs(): void {
    this.currentWlf = 2.0 * Math.PI * this.currentLfCutoff;

    // Effective stiffness scales with sqrt of saturation amount.
    // sqrt preserves the perceptual scaling: doubling satAmount roughly
    // doubles the perceived saturation depth.
    this.K_eff = this.coreStiffness * Math.sqrt(this.satGain);
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

    const K = this.K_eff;
    const wlf = this.currentWlf;
    const a = this.asymmetry;
    const twoOverT = 2.0 / this.T;

    if (K === 0 && a === 0) {
      // Fast path: perfectly linear (satAmount = 0, asymmetry = 0)
      // This collapses exactly into a pristine digital 1-pole HPF.
      phi = C / (wlf + twoOverT);
      this._cachedSatDepth = 0;
    } else {
      // Newton-Raphson Iteration using cosh²(K*Φ) magnetizing current.
      // F(Φ) = ω_LF * Φ * cosh²(K*Φ) * (1 + a*K*Φ) + (2/T)*Φ - C = 0
      //
      // Computed efficiently: e = exp(K*Φ), cosh = (e+1/e)/2, sinh = (e-1/e)/2
      // cosh² = (e² + 2 + e⁻²)/4, sinh(2x) = 2*sinh*cosh = (e²-e⁻²)/2

      // Phi clamp: keep K*Φ within ±200 to prevent exp overflow AND ensure
      // Newton can converge (clamping Kphi alone causes stalling if phi drifts
      // beyond the clamp region). At |K*Φ| = 200, cosh² ≈ e^400 which is
      // deep saturation — physical flux never reaches this.
      const phiMax = K > 0 ? 200 / K : 1e6;

      for (let i = 0; i < 5; i++) {
        phi = Math.max(-phiMax, Math.min(phiMax, phi));
        const Kphi = K * phi;
        const e = Math.exp(Kphi);
        const eInv = 1.0 / e;
        const coshKphi = (e + eInv) * 0.5;
        const cosh2 = coshKphi * coshKphi;
        const sinh2Kphi = (e * e - eInv * eInv) * 0.5; // sinh(2*K*Φ)
        const tilt = 1.0 + a * Kphi;

        // dI/dΦ = ω_LF * [cosh²*(1+2a*K*Φ) + K*Φ*sinh(2*K*Φ)*(1+a*K*Φ)]
        // Shared between F'(Φ) (Newton denominator) and saturation depth.
        // Guard: clamp to twoOverT so dF stays positive even when asymmetry
        // pushes the nonlinear term negative (sign-flip divergence prevention).
        const dIdPhi = wlf * (cosh2 * (1.0 + 2.0 * a * Kphi) +
                               K * phi * sinh2Kphi * tilt);
        const dF = Math.max(twoOverT, dIdPhi + twoOverT);

        // Cache saturation depth: reuses dIdPhi already computed above.
        // When unsaturated dIdPhi ≈ ω_LF, ratio → 0. When saturated it spikes → 1.
        this._cachedSatDepth = dIdPhi > wlf
          ? Math.max(0, Math.min(1, 1.0 - wlf / dIdPhi))
          : 0;

        // F(Φ) = ω_LF * Φ * cosh²(K*Φ) * (1 + a*K*Φ) + (2/T)*Φ - C
        const F = wlf * phi * cosh2 * tilt + twoOverT * phi - C;
        if (Math.abs(F) < 1e-10) break; // already converged — skip remaining iters

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

    // NaN guard only — cosh² naturally bounds flux, no hard clamp needed
    if (!Number.isFinite(x)) {
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
    this._cachedSatDepth = 0;
  }

  /**
   * Returns 0-1 indicating how deep the core is into saturation.
   * Value is cached inside process() at zero extra cost (reuses Newton loop intermediates).
   */
  getSaturationDepth(): number {
    return this._cachedSatDepth;
  }
}
