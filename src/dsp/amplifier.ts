/**
 * Amplifier models for tube and transistor saturation.
 *
 * - Tube mode: Nodal DK-Method circuit simulation of a common-cathode
 *   12AX7 triode stage with Cohen-Helie equations and power supply sag.
 * - Transistor mode: Symmetric hard-knee clipping with tanh compression
 *   above a threshold, producing odd harmonics characteristic of
 *   solid-state amplifiers.
 */

// ---------------------------------------------------------------------------
// Cohen-Helie 12AX7 tube model (DAFx 2010, fitted to measurements)
// ---------------------------------------------------------------------------

const CH_Gk = 2.14e-3;     // cathode current scaling
const CH_mu = 100.8;        // amplification factor
const CH_Ek = 1.303;        // cathode current exponent
const CH_Ck = 3.04;         // cathode transition smoothness
const CH_Gg = 6.06e-4;      // grid current scaling
const CH_Eg = 1.354;        // grid current exponent
const CH_Cg = 13.9;         // grid transition smoothness

/** Soft-plus: log(1 + exp(x)) with overflow protection. */
function softplus(x: number): number {
  if (x > 30) return x;
  if (x < -30) return 0;
  return Math.log(1 + Math.exp(x));
}

/** Cohen-Helie cathode current Ik(Vpk, Vgk). */
export function cohenHelieIk(Vpk: number, Vgk: number): number {
  const arg = CH_Ck * (Vpk / CH_mu + Vgk);
  return CH_Gk * Math.pow(softplus(arg) / CH_Ck, CH_Ek);
}

/** Cohen-Helie grid current Ig(Vgk). */
export function cohenHelieIg(Vgk: number): number {
  const arg = CH_Cg * Vgk;
  return CH_Gg * Math.pow(softplus(arg) / CH_Cg, CH_Eg);
}

/**
 * Analytical Jacobian of [Ip, Ig] w.r.t. [Vpk, Vgk].
 * Returns flat array [dIp/dVpk, dIp/dVgk, dIg/dVpk, dIg/dVgk].
 */
export function cohenHelieJacobian(Vpk: number, Vgk: number): number[] {
  // dIk/d(arg) chain
  const argK = CH_Ck * (Vpk / CH_mu + Vgk);
  const spK = softplus(argK);
  const sigK = 1 / (1 + Math.exp(-argK)); // sigmoid = d(softplus)/dx
  const baseK = spK / CH_Ck;
  const dIk_dargK = CH_Gk * CH_Ek * Math.pow(baseK, CH_Ek - 1) * sigK / CH_Ck;
  const dIk_dVpk = dIk_dargK * CH_Ck / CH_mu;
  const dIk_dVgk = dIk_dargK * CH_Ck;

  // dIg/dVgk
  const argG = CH_Cg * Vgk;
  const spG = softplus(argG);
  const sigG = 1 / (1 + Math.exp(-argG));
  const baseG = spG / CH_Cg;
  const dIg_dVgk = CH_Gg * CH_Eg * Math.pow(baseG, CH_Eg - 1) * sigG;

  // Ip = Ik - Ig, so dIp/dVpk = dIk/dVpk, dIp/dVgk = dIk/dVgk - dIg/dVgk
  return [
    dIk_dVpk,              // dIp/dVpk (Ig independent of Vpk)
    dIk_dVgk - dIg_dVgk,   // dIp/dVgk
    0,                      // dIg/dVpk
    dIg_dVgk,              // dIg/dVgk
  ];
}

// ---------------------------------------------------------------------------
// Circuit component types
// ---------------------------------------------------------------------------

export interface TubeCircuitParams {
  Rp: number;      // plate load resistor (ohms)
  Rg: number;      // grid leak resistor (ohms)
  Rk: number;      // cathode resistor (ohms)
  Cc_in: number;   // input coupling cap (farads)
  Cc_out: number;  // output coupling cap (farads)
  Ck: number;      // cathode bypass cap (farads)
  Vpp: number;     // plate supply voltage (volts)
}

const DEFAULT_CIRCUIT: TubeCircuitParams = {
  Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
  Cc_in: 22e-9, Cc_out: 100e-9, Ck: 25e-6,
  Vpp: 250,
};

// ---------------------------------------------------------------------------
// AmplifierModel
// ---------------------------------------------------------------------------

export class AmplifierModel {
  private mode: 'tube' | 'transistor';
  private drive: number;
  private circuitParams: TubeCircuitParams;
  private fs: number;

  // Tube mode state
  private x = [0, 0, 0];         // [V_Cc_in, V_Cc_out, V_Ck]
  private i_nl_prev = [0, 0];    // [Ip, Ig] from previous sample
  private _sagVpp = 0;             // plate supply (modified by sag model)
  private sagVscreen = 0;         // screen/second filter cap voltage
  private dcPlateVoltage = 1;     // DC plate voltage for normalization

  // Output load resistance (next stage grid input impedance)
  private static readonly RLOAD = 1e6;

  // Power supply sag parameters (tuned for audible effect — lumped impedance
  // representing rectifier + choke + winding resistance of a tube supply)
  private static readonly SAG_R_OUT = 5000;       // supply output impedance
  private static readonly SAG_R_FILTER = 4700;    // inter-stage filter R
  private static readonly SAG_C1 = 10e-6;         // first filter cap
  private static readonly SAG_C2 = 22e-6;         // second filter cap
  private static readonly SAG_R_BLEEDER = 220e3;  // bleeder resistor

  // Peak-tracking envelope for plate current (drives sag model)
  private sagIpEnvelope = 0;
  private sagAttackCoeff = 0;   // ~1ms attack
  private sagReleaseCoeff = 0;  // ~100ms release

  // State-space matrices (precomputed from circuit topology + trapezoidal rule)
  // v_nl = Hd*x + Kd_vin*u + Kd_vpp*Vpp + Ld*i_nl
  private Hd = new Float64Array(6);      // 2x3 row-major
  private Kd_vin = new Float64Array(2);  // 2x1
  private Kd_vpp = new Float64Array(2);  // 2x1
  private Ld = new Float64Array(4);      // 2x2 row-major
  // x_next = diag(Ad)*x + Bd_vin*u + Bd_vpp*Vpp + Cd*i_nl
  private Ad = new Float64Array(3);      // diagonal
  private Bd_vin = new Float64Array(3);  // 3x1
  private Bd_vpp = new Float64Array(3);  // 3x1
  private Cd = new Float64Array(6);      // 3x2 row-major
  // y = Dd*x + Ed_vpp*Vpp + Fd*i_nl
  private Dd = new Float64Array(3);      // 1x3
  private Ed_vpp = 0;
  private Fd = new Float64Array(2);      // 1x2

  constructor(
    mode: 'tube' | 'transistor',
    drive = 1.0,
    circuitParams?: TubeCircuitParams,
    fs = 48000,
  ) {
    this.mode = mode;
    this.drive = mode === 'tube' ? 0.5 + drive * 4.0 : drive;
    this.circuitParams = circuitParams ?? DEFAULT_CIRCUIT;
    this.fs = fs;

    if (mode === 'tube') {
      const T = 1 / fs;
      this.sagAttackCoeff = 1 - Math.exp(-T / 0.001);
      this.sagReleaseCoeff = 1 - Math.exp(-T / 0.100);
      this.initStateSpace();
      this.solveDCOperatingPoint();
    }
  }

  setDrive(v: number): void {
    this.drive = this.mode === 'tube' ? 0.5 + v * 4.0 : v;
  }

  /** Current plate supply voltage (for diagnostics/testing). */
  getSagVpp(): number {
    return this._sagVpp;
  }

  process(input: number): number {
    const driven = input * this.drive;
    if (this.mode === 'tube') {
      return this.tubeProcess(driven);
    }
    return this.transistorSaturate(driven);
  }

  reset(): void {
    if (this.mode === 'tube') {
      this.solveDCOperatingPoint();
    }
  }

  // -------------------------------------------------------------------------
  // State-space matrix derivation (DK-method, trapezoidal discretization)
  // -------------------------------------------------------------------------

  /**
   * Derive discrete state-space matrices from circuit topology.
   *
   * Circuit: common-cathode 12AX7 triode stage.
   *   Input --[Cc_in]-- grid --[Rg]-- GND
   *   Vpp --[Rp]-- plate --(triode)-- cathode --[Rk||Ck]-- GND
   *   plate --[Cc_out]-- output --[Rl]-- GND
   *
   * Trapezoidal rule replaces each capacitor C with companion resistance
   * Rc = T/(2C) in series with history voltage source (the state variable).
   *
   * KCL at 4 nodes (grid, plate, cathode, output) solved symbolically
   * yields closed-form matrices relating state x, input Vin, supply Vpp,
   * and nonlinear tube currents [Ip, Ig] to port voltages, state update,
   * and output.
   */
  private initStateSpace(): void {
    const T = 1 / this.fs;
    const { Rp, Rg, Rk, Cc_in, Cc_out, Ck } = this.circuitParams;
    const Rl = AmplifierModel.RLOAD;

    // Companion resistances
    const Rc1 = T / (2 * Cc_in);
    const Rc2 = T / (2 * Cc_out);
    const Rc3 = T / (2 * Ck);

    // Node conductance sums
    const G1 = 1 / Rc1 + 1 / Rg;
    const G2 = 1 / Rp + 1 / (Rc2 + Rl);
    const G3 = 1 / Rk + 1 / Rc3;

    // Node voltage coefficients:
    //   V1 = a1*Vin - b1*x1 - c1*Ig
    //   V2 = a2*Vpp + b2*x2 - c2*Ip
    //   V3 = a3*(Ip+Ig) + b3*x3
    //   V4 = rl_frac*(V2 - x2)
    const a1 = 1 / (Rc1 * G1);
    const b1 = a1;
    const c1 = 1 / G1;
    const a2 = 1 / (Rp * G2);
    const b2 = 1 / ((Rc2 + Rl) * G2);
    const c2 = 1 / G2;
    const a3 = 1 / G3;
    const b3 = 1 / (Rc3 * G3);
    const rl_frac = Rl / (Rc2 + Rl);
    const rc_frac = Rc2 / (Rc2 + Rl);

    // v_nl = Hd*x + Kd_vin*Vin + Kd_vpp*Vpp + Ld*i_nl
    // Vpk = V2 - V3, Vgk = V1 - V3
    this.Hd[0] = 0;     this.Hd[1] = b2;    this.Hd[2] = -b3;   // Vpk
    this.Hd[3] = -b1;   this.Hd[4] = 0;     this.Hd[5] = -b3;   // Vgk

    this.Kd_vin[0] = 0;  this.Kd_vin[1] = a1;
    this.Kd_vpp[0] = a2; this.Kd_vpp[1] = 0;

    this.Ld[0] = -(c2 + a3); this.Ld[1] = -a3;
    this.Ld[2] = -a3;        this.Ld[3] = -(c1 + a3);

    // x_next = Ad*x + Bd_vin*Vin + Bd_vpp*Vpp + Cd*i_nl
    this.Ad[0] = 2 * b1 - 1;
    this.Ad[1] = 2 * rc_frac * b2 + 2 * rl_frac - 1;
    this.Ad[2] = 2 * b3 - 1;

    this.Bd_vin[0] = 2 - 2 * a1; this.Bd_vin[1] = 0; this.Bd_vin[2] = 0;
    this.Bd_vpp[0] = 0; this.Bd_vpp[1] = 2 * rc_frac * a2; this.Bd_vpp[2] = 0;

    this.Cd[0] = 0;                this.Cd[1] = 2 * c1;
    this.Cd[2] = -2 * rc_frac * c2; this.Cd[3] = 0;
    this.Cd[4] = 2 * a3;           this.Cd[5] = 2 * a3;

    // y = Dd*x + Ed_vpp*Vpp + Fd*i_nl  (Ed_vin = 0)
    this.Dd[0] = 0; this.Dd[1] = rl_frac * (b2 - 1); this.Dd[2] = 0;
    this.Ed_vpp = rl_frac * a2;
    this.Fd[0] = -rl_frac * c2; this.Fd[1] = 0;
  }

  // -------------------------------------------------------------------------
  // DC operating point solver
  // -------------------------------------------------------------------------

  private solveDCOperatingPoint(): void {
    const { Rp, Rk, Vpp } = this.circuitParams;

    // At DC: capacitors are open circuits.
    // Grid at ground (Rg pulls to 0), so Vgk = -Vk.
    // Two-level Newton solve: outer on Vk, inner 1D Newton on Ik.
    let Vk = 1.0;

    for (let outer = 0; outer < 50; outer++) {
      const Vgk = -Vk;
      const Ig = cohenHelieIg(Vgk);

      // Inner 1D Newton: h(Ik) = Ik - cohenHelieIk(Vpp-(Ik-Ig)*Rp-Vk, Vgk)
      let Ik = 0.001;
      for (let inner = 0; inner < 20; inner++) {
        const Vpk = Vpp - (Ik - Ig) * Rp - Vk;
        const Ik_eval = cohenHelieIk(Vpk, Vgk);
        const residual = Ik - Ik_eval;
        if (Math.abs(residual) < 1e-9) break;
        // h'(Ik) = 1 + Rp * dIk/dVpk
        const J = cohenHelieJacobian(Vpk, Vgk);
        const dh = 1 + Rp * J[0];
        if (Math.abs(dh) < 1e-15) break;
        Ik -= residual / dh;
      }

      const Vk_new = Ik * Rk;
      if (Math.abs(Vk_new - Vk) < 1e-6) break;
      Vk = Vk_new;
    }

    const Ig_dc = cohenHelieIg(-Vk);
    const Ik_dc = Vk / Rk;
    const Ip_dc = Ik_dc - Ig_dc;
    const Vp_dc = Vpp - Ip_dc * Rp;
    this.dcPlateVoltage = Vp_dc;

    // Initialize capacitor states at DC operating point
    this.x[0] = 0;       // V_Cc_in = 0 (no DC across input coupling cap)
    this.x[1] = Vp_dc;   // V_Cc_out = plate voltage (DC blocked at output)
    this.x[2] = Vk;      // V_Ck = cathode voltage

    this.i_nl_prev[0] = Ip_dc;
    this.i_nl_prev[1] = Ig_dc;
    this.sagIpEnvelope = Ip_dc;

    // Compute DC steady-state sag voltages:
    //   dVss/dt=0 → (Vpp-Vss)/R_FILTER = Vss/R_BLEEDER → Vss = Vpp*R_BLEEDER/(R_FILTER+R_BLEEDER)
    //   dVpp/dt=0 → (Videal-Vpp)/R_OUT = Ip + Vss/R_BLEEDER
    const Rf = AmplifierModel.SAG_R_FILTER;
    const Rb = AmplifierModel.SAG_R_BLEEDER;
    const Ro = AmplifierModel.SAG_R_OUT;
    // Solve: Vpp_ss = Videal - Ro * (Ip + Vpp_ss/(Rf+Rb))
    // Vpp_ss * (1 + Ro/(Rf+Rb)) = Videal - Ro*Ip
    const sagVpp_ss = (Vpp - Ro * Ip_dc) / (1 + Ro / (Rf + Rb));
    const sagVss_ss = sagVpp_ss * Rb / (Rf + Rb);
    this._sagVpp = sagVpp_ss;
    this.sagVscreen = sagVss_ss;

    // Warmup: run the discrete system to its own numerical steady state.
    // The continuous DC solution has tiny rounding mismatch with the discrete
    // trapezoidal system — a few hundred samples of silence eliminate the
    // startup transient.
    // Sag τ = R_OUT * C1 = 50ms. Need ~5τ (12000 samples at 48kHz)
    // to settle both the sag model and discrete trapezoidal state.
    for (let i = 0; i < 12000; i++) {
      this.tubeProcess(0);
    }
  }

  // -------------------------------------------------------------------------
  // Per-sample tube processing with Newton-Raphson solver
  // -------------------------------------------------------------------------

  private tubeProcess(u: number): number {
    const x = this.x;
    const Vpp = this._sagVpp;

    // Newton-Raphson: solve for nonlinear tube currents [Ip, Ig]
    let Ip = this.i_nl_prev[0];
    let Ig = this.i_nl_prev[1];

    for (let iter = 0; iter < 8; iter++) {
      // Tube port voltages: v_nl = Hd*x + Kd_vin*u + Kd_vpp*Vpp + Ld*i_nl
      const Vpk = this.Hd[1] * x[1] + this.Hd[2] * x[2]
                + this.Kd_vpp[0] * Vpp
                + this.Ld[0] * Ip + this.Ld[1] * Ig;
      const Vgk = this.Hd[3] * x[0] + this.Hd[5] * x[2]
                + this.Kd_vin[1] * u
                + this.Ld[2] * Ip + this.Ld[3] * Ig;

      // Evaluate tube model at current port voltages
      const Ik_eval = cohenHelieIk(Vpk, Vgk);
      const Ig_eval = cohenHelieIg(Vgk);
      const Ip_eval = Ik_eval - Ig_eval;

      // Residual: difference between assumed and evaluated currents
      const r0 = Ip - Ip_eval;
      const r1 = Ig - Ig_eval;
      if (Math.abs(r0) < 1e-9 && Math.abs(r1) < 1e-9) break;

      // Jacobian J = d[Ip,Ig]/d[Vpk,Vgk]
      const J = cohenHelieJacobian(Vpk, Vgk);

      // Newton matrix: M = I - J * Ld  (2x2)
      const M00 = 1 - (J[0] * this.Ld[0] + J[1] * this.Ld[2]);
      const M01 = -(J[0] * this.Ld[1] + J[1] * this.Ld[3]);
      const M10 = -(J[2] * this.Ld[0] + J[3] * this.Ld[2]);
      const M11 = 1 - (J[2] * this.Ld[1] + J[3] * this.Ld[3]);

      const det = M00 * M11 - M01 * M10;
      if (Math.abs(det) < 1e-15) break;

      // Solve M * delta = -residual via Cramer's rule
      const d0 = -(M11 * r0 - M01 * r1) / det;
      const d1 = -(-M10 * r0 + M00 * r1) / det;
      Ip += d0;
      Ig += d1;
    }

    // Store converged currents for next sample's initial guess
    this.i_nl_prev[0] = Ip;
    this.i_nl_prev[1] = Ig;

    // Output: y = Dd*x + Ed_vpp*Vpp + Fd*i_nl
    const y = this.Dd[1] * x[1]
            + this.Ed_vpp * Vpp
            + this.Fd[0] * Ip;

    // State update: x_next = Ad*x + Bd_vin*u + Bd_vpp*Vpp + Cd*i_nl
    const x0 = this.Ad[0] * x[0] + this.Bd_vin[0] * u + this.Cd[1] * Ig;
    const x1 = this.Ad[1] * x[1] + this.Bd_vpp[1] * Vpp + this.Cd[2] * Ip;
    const x2 = this.Ad[2] * x[2] + this.Cd[4] * Ip + this.Cd[5] * Ig;
    this.x[0] = x0;
    this.x[1] = x1;
    this.x[2] = x2;

    // Peak-track plate current for sag model (fast attack, slow release).
    // Cathode-biased preamp tubes don't increase average Ip much under
    // overdrive (bias shift effect), but peak Ip increases significantly.
    // The envelope captures this peak behavior for audible sag.
    if (Ip > this.sagIpEnvelope) {
      this.sagIpEnvelope += this.sagAttackCoeff * (Ip - this.sagIpEnvelope);
    } else {
      this.sagIpEnvelope += this.sagReleaseCoeff * (Ip - this.sagIpEnvelope);
    }
    this.updateSag(this.sagIpEnvelope);

    // Normalize output: raw y is in volts, scale to ~[-1,1]
    return y / this.dcPlateVoltage;
  }

  // -------------------------------------------------------------------------
  // Power supply sag model (forward-Euler)
  // -------------------------------------------------------------------------

  private updateSag(Ip: number): void {
    const T = 1 / this.fs;
    const Vpp = this._sagVpp;
    const Vss = this.sagVscreen;
    const Videal = this.circuitParams.Vpp;

    // Rectifier current: (Videal - Vpp) / R_OUT models the supply recharging
    // the filter cap. When Vpp < Videal (sag), current flows in to restore.
    const Irect = (Videal - Vpp) / AmplifierModel.SAG_R_OUT;
    const dVpp = (Irect - Ip - (Vpp - Vss) / AmplifierModel.SAG_R_FILTER)
                 / AmplifierModel.SAG_C1;
    const dVss = ((Vpp - Vss) / AmplifierModel.SAG_R_FILTER - Vss / AmplifierModel.SAG_R_BLEEDER)
                 / AmplifierModel.SAG_C2;

    this._sagVpp = Vpp + T * dVpp;
    this.sagVscreen = Vss + T * dVss;
  }

  // -------------------------------------------------------------------------
  // Transistor mode (unchanged)
  // -------------------------------------------------------------------------

  private transistorSaturate(x: number): number {
    const threshold = 0.85;
    const absX = Math.abs(x);
    if (absX < threshold) return x;
    const excess = absX - threshold;
    const compressed =
      threshold + (1 - threshold) * Math.tanh(excess / (1 - threshold));
    return Math.sign(x) * compressed;
  }
}
