/**
 * Jiles-Atherton magnetic hysteresis model with RK4 ODE solver.
 *
 * Based on the Chow Tape Model (Jatin Chowdhury, DAFx 2019).
 * This is the core tape saturation engine that models the nonlinear
 * magnetization behavior of ferromagnetic tape media.
 */

const C_MAX = 0.99;
const H_LIMIT = 256;
const DEN_EPS = 1e-9;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Per-sample hysteresis processor implementing the Jiles-Atherton model.
 *
 * The model tracks the magnetization M of the tape as a function of the
 * applied magnetic field H (the input signal). The nonlinear relationship
 * between H and M produces harmonic distortion characteristic of analog
 * tape saturation.
 */
export class HysteresisProcessor {
  // J-A model parameters
  private Ms = 1.0; // saturation magnetization
  private a = 1.0; // domain shape parameter (derived from drive)
  private k = 0.47875; // pinning parameter (constant)
  private c = 0.1; // reversibility parameter (derived from width)
  private alpha = 1.6e-3; // inter-domain coupling (constant)
  private baseC = 0.1; // tape formulation baseline reversibility (underbias floor)
  private biasAmplitude = 0; // physical bias amplitude from knob
  private biasActive = false; // true when adaptive bias mode is active (vs direct setC)

  // User-facing parameters (stored for cook())
  private drive = 0.5;
  private saturation = 0.5;

  // Alpha-transform derivative constant
  private readonly dAlpha = 0.75;

  // Sample period
  private readonly T: number;

  // State variables
  private M_n1 = 0; // previous magnetization
  private H_n1 = 0; // previous applied field
  private H_d_n1 = 0; // previous field derivative

  constructor(sampleRate: number) {
    this.T = 1.0 / sampleRate;
    this.cook();
  }

  setDrive(v: number): void {
    this.drive = Math.max(0, Math.min(1, v));
    this.cook();
  }

  setSaturation(v: number): void {
    this.saturation = Math.max(0, Math.min(1, v));
    this.cook();
  }

  /**
   * Set the tape formulation's baseline reversibility (underbias floor).
   * This is the c value when no AC bias is applied (bias=0).
   * Different tape stocks have different intrinsic domain reversibility.
   */
  setBaseC(v: number): void {
    this.baseC = Math.max(0.01, Math.min(0.5, v));
  }

  /**
   * Set bias level (0-1). Stores the bias amplitude for signal-adaptive
   * reversibility computation in process(). The effective c is computed
   * per-sample: quiet signals get strong linearization (high c), loud
   * signals overwhelm the bias (low c, more distortion).
   */
  setBias(v: number): void {
    this.biasAmplitude = Math.max(0, Math.min(1, v));
    this.biasActive = true;
  }

  setWidth(v: number): void {
    this.c = Math.max(0.01, Math.sqrt(1.0 - Math.max(0, Math.min(1, v))) - 0.01);
    this.biasActive = false;
  }

  /** Set pinning parameter k directly (range 0.1-1.0). */
  setK(v: number): void {
    this.k = Math.max(0.1, Math.min(1.0, v));
  }

  /** Set reversibility parameter c directly (range 0.01-0.99). */
  setC(v: number): void {
    this.c = Math.max(0.01, Math.min(0.99, v));
    this.biasActive = false;
  }

  /** Set inter-domain coupling parameter alpha (range 1e-4 to 5e-3). */
  setAlpha(v: number): void {
    this.alpha = Math.max(1e-4, Math.min(5e-3, v));
  }

  private computeAdaptiveC(H: number): number {
    const bSq = this.biasAmplitude * this.biasAmplitude;
    const denomSq = bSq + H * H;
    if (denomSq < 1e-20) return this.baseC;
    return this.baseC + (C_MAX - this.baseC) * this.biasAmplitude / Math.sqrt(denomSq);
  }

  /** Returns the effective c for a given H value (adaptive if bias mode, flat otherwise). */
  getEffectiveC(H: number): number {
    if (!this.biasActive) return this.c;
    return this.computeAdaptiveC(H);
  }

  private cook(): void {
    this.Ms = 0.5 + 1.5 * (1.0 - this.saturation);
    // Map drive 0..1 to a range where the Langevin function stays well-behaved.
    // At drive=0 → a=Ms/0.5 (gentle saturation), drive=1 → a=Ms/4.0 (hard saturation).
    this.a = this.Ms / (0.5 + 3.5 * this.drive);
  }

  /**
   * Process a single input sample through the hysteresis model.
   * @param input The input signal sample (treated as applied field H)
   * @returns The magnetization output, normalized by upperLim
   */
  process(input: number): number {
    if (!Number.isFinite(input)) {
      this.reset();
      return 0;
    }

    // Extreme field values are non-physical and can destabilize the derivative path.
    const H = clamp(input, -H_LIMIT, H_LIMIT);
    const T = this.T;

    // Alpha-transform derivative of H
    const H_d_raw =
      ((1 + this.dAlpha) / T) * (H - this.H_n1) -
      this.dAlpha * this.H_d_n1;
    // dH/dt bound from physical tape/head bandwidth. Keeps pathological transients
    // from exploding the ODE while leaving normal audio behavior unchanged.
    const H_d_limit = 2 * Math.PI * 80_000 * (1 + Math.abs(H));
    const H_d = clamp(H_d_raw, -H_d_limit, H_d_limit);

    // Midpoint values for RK4
    const H_mid = (H + this.H_n1) * 0.5;
    const H_d_mid = (H_d + this.H_d_n1) * 0.5;

    // Compute effective c at each RK4 evaluation point.
    // When biasActive, c depends on the instantaneous H so each stage gets
    // the correct value for its H. When flat, getEffectiveC returns this.c
    // for all three calls at negligible cost.
    const c1   = this.getEffectiveC(this.H_n1);
    const cMid = this.getEffectiveC(H_mid);
    const c4   = this.getEffectiveC(H);

    // RK4 integration
    const k1 = T * this.dMdt(this.M_n1,          this.H_n1, this.H_d_n1, c1);
    const k2 = T * this.dMdt(this.M_n1 + k1 * 0.5, H_mid,  H_d_mid,     cMid);
    const k3 = T * this.dMdt(this.M_n1 + k2 * 0.5, H_mid,  H_d_mid,     cMid);
    const k4 = T * this.dMdt(this.M_n1 + k3,     H,         H_d,         c4);

    let M_new = this.M_n1 + (k1 + 2 * k2 + 2 * k3 + k4) / 6;
    if (!Number.isFinite(M_new)) {
      this.reset();
      return 0;
    }
    // Keep magnetization within a wide but finite envelope to avoid runaway.
    const mLimit = this.Ms * 8;
    M_new = clamp(M_new, -mLimit, mLimit);

    // Update state for next sample
    this.M_n1 = M_new;
    this.H_n1 = H;
    this.H_d_n1 = H_d;

    // Normalize by Ms so output stays in roughly [-1, 1] range
    const out = M_new / this.Ms;
    // Non-finite safety: if the model diverges, output silence rather than poisoning downstream.
    if (!Number.isFinite(out)) {
      this.M_n1 = 0;
      this.H_n1 = 0;
      this.H_d_n1 = 0;
      return 0;
    }
    return out;
  }

  /** Reset all state to zero. */
  reset(): void {
    this.M_n1 = 0;
    this.H_n1 = 0;
    this.H_d_n1 = 0;
  }

  /** Returns 0-1 indicating how close magnetization is to saturation. */
  getSaturationDepth(): number {
    return Math.min(1, Math.abs(this.M_n1) / this.Ms);
  }

  /**
   * Compute the time derivative of magnetization dM/dt.
   *
   * This is the core of the Jiles-Atherton model, computing how
   * magnetization changes based on the current state.
   */
  private dMdt(M: number, H: number, H_d: number, c: number): number {
    const Q = (H + this.alpha * M) / this.a;
    if (!Number.isFinite(Q)) return 0;

    let L: number; // Langevin function value
    let Ld: number; // Langevin function derivative

    // Near-zero guard for numerical stability
    if (Math.abs(Q) < 0.001) {
      L = Q / 3;
      Ld = 1 / 3;
    } else if (Math.abs(Q) > 500) {
      // Large |Q| guard: coth(Q) → sign(Q), Ld → 0
      // Prevents cosh/sinh overflow producing NaN
      L = Math.sign(Q) - 1 / Q;
      Ld = 1 / (Q * Q);
    } else {
      const cothQ = Math.cosh(Q) / Math.sinh(Q);
      L = cothQ - 1 / Q;
      Ld = 1 / (Q * Q) - cothQ * cothQ + 1;
    }

    const M_an = this.Ms * L; // anhysteretic magnetization
    const M_diff = M_an - M;

    // Delta: direction of magnetization change
    const delta = H_d >= 0 ? 1 : -1;

    // kap1: irreversible component gating, weighted by (1-c).
    // Only active when delta and M_diff have the same sign.
    // The (1-c) factor belongs here in the numerator only.
    const kap1 = Math.sign(delta) === Math.sign(M_diff) ? (1 - c) : 0;

    // f1: irreversible magnetization component
    // Denominator is delta*k - alpha*M_diff (no (1-c) factor on k).
    const f1_denom = delta * this.k - this.alpha * M_diff;
    const f1_denom_safe = Math.abs(f1_denom) < DEN_EPS
      ? (f1_denom < 0 ? -DEN_EPS : DEN_EPS)
      : f1_denom;
    const f1 = kap1 * M_diff / f1_denom_safe;

    // f2: reversible magnetization component
    const f2 = Ld * c * this.Ms / this.a;

    // f3: denominator correction factor
    const f3 = 1 - Ld * this.alpha * c * this.Ms / this.a;
    const f3_safe = Math.abs(f3) < DEN_EPS ? (f3 < 0 ? -DEN_EPS : DEN_EPS) : f3;

    const slope = H_d * (f1 + f2) / f3_safe;
    if (!Number.isFinite(slope)) return 0;

    // Bound dM per sample to avoid solver runaway on pathological transients.
    const dMdtLimit = (4 * this.Ms) / this.T;
    return clamp(slope, -dMdtLimit, dMdtLimit);
  }
}
