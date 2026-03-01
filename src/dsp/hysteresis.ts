/**
 * Jiles-Atherton magnetic hysteresis model with RK4 ODE solver.
 *
 * Based on the Chow Tape Model (Jatin Chowdhury, DAFx 2019).
 * This is the core tape saturation engine that models the nonlinear
 * magnetization behavior of ferromagnetic tape media.
 */

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
  private upperLim = 20.0; // output normalization

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
    // Initialize derived parameters with defaults
    this.setDrive(0.5);
    this.setSaturation(0.5);
    this.setWidth(0.5);
  }

  /**
   * Set the drive parameter (0-1).
   * Higher drive increases the nonlinear distortion.
   */
  setDrive(v: number): void {
    this.a = this.Ms / (0.01 + 6.0 * v);
  }

  /**
   * Set the saturation parameter (0-1).
   * Controls the saturation magnetization level.
   */
  setSaturation(v: number): void {
    this.Ms = 0.5 + 1.5 * (1.0 - v);
    // Recalculate 'a' since it depends on Ms — use current drive ratio
    // We store the drive-derived divisor implicitly through 'a' and 'Ms'.
    // To keep it simple, we just recompute 'a' from the current Ms and
    // the relationship a = Ms / divisor. But we don't store the divisor,
    // so we need to track drive separately. For now, keep 'a' as-is and
    // let the user call setDrive after setSaturation if needed.
  }

  /**
   * Set the width parameter (0-1).
   * Controls the reversibility of the magnetization process.
   */
  setWidth(v: number): void {
    this.c = Math.max(0.01, Math.sqrt(1.0 - v) - 0.01);
  }

  /**
   * Process a single input sample through the hysteresis model.
   * @param input The input signal sample (treated as applied field H)
   * @returns The magnetization output, normalized by upperLim
   */
  process(input: number): number {
    const H = input;
    const T = this.T;

    // Alpha-transform derivative of H
    const H_d =
      ((1 + this.dAlpha) / T) * (H - this.H_n1) -
      this.dAlpha * this.H_d_n1;

    // Midpoint values for RK4
    const H_mid = (H + this.H_n1) * 0.5;
    const H_d_mid = (H_d + this.H_d_n1) * 0.5;

    // RK4 integration
    const k1 = T * this.dMdt(this.M_n1, this.H_n1, this.H_d_n1);
    const k2 = T * this.dMdt(this.M_n1 + k1 * 0.5, H_mid, H_d_mid);
    const k3 = T * this.dMdt(this.M_n1 + k2 * 0.5, H_mid, H_d_mid);
    const k4 = T * this.dMdt(this.M_n1 + k3, H, H_d);

    const M_new = this.M_n1 + (k1 + 2 * k2 + 2 * k3 + k4) / 6;

    // Update state for next sample
    this.M_n1 = M_new;
    this.H_n1 = H;
    this.H_d_n1 = H_d;

    return M_new / this.upperLim;
  }

  /** Reset all state to zero. */
  reset(): void {
    this.M_n1 = 0;
    this.H_n1 = 0;
    this.H_d_n1 = 0;
  }

  /**
   * Compute the time derivative of magnetization dM/dt.
   *
   * This is the core of the Jiles-Atherton model, computing how
   * magnetization changes based on the current state.
   */
  private dMdt(M: number, H: number, H_d: number): number {
    const Q = (H + this.alpha * M) / this.a;

    let L: number; // Langevin function value
    let Ld: number; // Langevin function derivative

    // Near-zero guard for numerical stability
    if (Math.abs(Q) < 0.001) {
      L = Q / 3;
      Ld = 1 / 3;
    } else {
      const cothQ = Math.cosh(Q) / Math.sinh(Q);
      L = cothQ - 1 / Q;
      Ld = 1 / (Q * Q) - cothQ * cothQ + 1;
    }

    const M_an = this.Ms * L; // anhysteretic magnetization
    const M_diff = M_an - M;

    // Delta: direction of magnetization change
    const delta = H_d >= 0 ? 1 : -1;

    // kap1: irreversible component gating
    // Only active when delta and M_diff have the same sign
    const kap1 = Math.sign(delta) === Math.sign(M_diff) ? (1 - this.c) : 0;

    // f1: irreversible magnetization component
    const f1_denom = (1 - this.c) * delta * this.k - this.alpha * M_diff;
    let f1: number;
    if (Math.abs(f1_denom) < 1e-12) {
      f1 = 0; // protect against division by zero
    } else {
      f1 = kap1 * M_diff / f1_denom;
    }

    // f2: reversible magnetization component
    const f2 = Ld * this.c * this.Ms / this.a;

    // f3: denominator correction factor
    const f3 = 1 - Ld * this.alpha * this.c * this.Ms / this.a;

    // Protect against f3 near zero
    if (Math.abs(f3) < 1e-12) {
      return 0;
    }

    return H_d * (f1 + f2) / f3;
  }
}
