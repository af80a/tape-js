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

/**
 * Grid current Ig(Vgk).
 * Upgraded to a continuously differentiable softplus Child-Langmuir model
 * with a -0.7V thermal contact potential for zero-compromise physical accuracy.
 */
export function gridCurrentIg(Vgk: number): number {
  const V_contact = -0.7;
  const arg = (Vgk - V_contact) * 10;
  let V_eff = 0;
  if (arg > 30) {
    V_eff = arg / 10;
  } else if (arg < -30) {
    V_eff = 0;
  } else {
    V_eff = Math.log(1 + Math.exp(arg)) / 10;
  }
  return 1e-9 + 1.5e-3 * Math.pow(V_eff, 1.5);
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

  // dIg/dVgk (Derivative of Child-Langmuir grid model)
  const V_contact = -0.7;
  const arg = (Vgk - V_contact) * 10;
  let V_eff = 0;
  let dVeff_dVgk = 0;
  if (arg > 30) {
    V_eff = arg / 10;
    dVeff_dVgk = 1;
  } else if (arg < -30) {
    V_eff = 0;
    dVeff_dVgk = 0;
  } else {
    V_eff = Math.log(1 + Math.exp(arg)) / 10;
    dVeff_dVgk = 1 / (1 + Math.exp(-arg));
  }
  const dIg_dVgk = 1.5 * 1.5e-3 * Math.sqrt(V_eff) * dVeff_dVgk;

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
  private driveRaw: number;
  private circuitParams: TubeCircuitParams;
  private fs: number;

  // Tube mode state (4 states now, natively including C_ga for Miller effect)
  private x = [0, 0, 0, 0];         // [V_Cc_in, V_Cc_out, V_Ck, V_Cga]
  private i_nl_prev = [0, 0];       // [Ip, Ig] from previous sample
  private _saturationDepth = 0;
  private _sagVpp = 0;             // plate supply (modified by sag model)
  private sagVscreen = 0;         // screen/second filter cap voltage
  private dcPlateVoltage = 1;     // DC plate voltage for normalization
  
  // Physical constants
  private static readonly C_ga = 1.7e-12; // 12AX7 grid-to-anode capacitance (1.7pF)
  private static readonly R_source = 68e3; // Typical guitar/pedal source impedance (68k)

  // Output load resistance (next stage grid input impedance)
  private static readonly RLOAD = 1e6;

  // Power supply sag parameters (Sag v2.0 Physical Rectifier)
  private static readonly SAG_MAINS_FREQ = 60;     // AC Mains frequency (Hz)
  private static readonly SAG_R_SEC = 150;         // Transformer secondary resistance (ohms)
  private static readonly SAG_K_RECT = 2e-4;       // Rectifier tube perveance (Child-Langmuir)
  private static readonly SAG_R_FILTER = 4700;     // inter-stage filter R
  private static readonly SAG_C1 = 47e-6;          // first filter cap
  private static readonly SAG_C2 = 22e-6;          // second filter cap
  private static readonly SAG_R_BLEEDER = 220e3;   // bleeder resistor

  private acPhase = 0;            // Phase of the AC mains

  // State-space matrices (precomputed from circuit topology + trapezoidal rule)
  // v_nl = Hd*x + Kd_vin*u + Kd_vpp*Vpp + Ld*i_nl
  private Hd = new Float64Array(8);      // 2x4 row-major
  private Kd_vin = new Float64Array(2);  // 2x1
  private Kd_vpp = new Float64Array(2);  // 2x1
  private Ld = new Float64Array(4);      // 2x2 row-major
  // x_next = Ad*x + Bd_vin*u + Bd_vpp*Vpp + Cd*i_nl
  private Ad = new Float64Array(16);     // 4x4 row-major
  private Bd_vin = new Float64Array(4);  // 4x1
  private Bd_vpp = new Float64Array(4);  // 4x1
  private Cd = new Float64Array(8);      // 4x2 row-major
  // y = Dd*x + Ed_vpp*Vpp + Fd*i_nl
  private Dd = new Float64Array(4);      // 1x4
  private Ed_vpp = 0;
  private Fd = new Float64Array(2);      // 1x2

  constructor(
    mode: 'tube' | 'transistor',
    drive = 1.0,
    circuitParams?: TubeCircuitParams,
    fs = 48000,
  ) {
    this.mode = mode;
    this.driveRaw = drive;
    this.drive = mode === 'tube' ? 0.1 + drive * 5.0 : drive;
    this.circuitParams = circuitParams ?? DEFAULT_CIRCUIT;
    this.fs = fs;

    if (mode === 'tube') {
      this.initStateSpace();
      this.solveDCOperatingPoint();
    }
  }

  setDrive(v: number): void {
    this.driveRaw = v;
    // Map 0-1 to a range that allows very clean operation (0.1) up to heavy saturation (5.1)
    this.drive = this.mode === 'tube' ? 0.1 + v * 5.0 : v;
  }

  /**
   * Update plate supply voltage in-place without rebuilding the model.
   * The sag integrator drifts towards the new Vpp naturally via the AC mains cycle,
   * and the output normalization is updated proportionally.
   */
  setVpp(vpp: number): void {
    if (this.mode !== 'tube') return;
    const oldVpp = this.circuitParams.Vpp;
    this.circuitParams = { ...this.circuitParams, Vpp: vpp };
    // Scale normalization proportionally — correct during gradual knob changes
    this.dcPlateVoltage = Math.max(1, this.dcPlateVoltage * vpp / Math.max(1, oldVpp));
    // _sagVpp drifts to new target via updateSag() — no state reset needed
  }

  /** Raw 0-1 drive value (for preserving drive when recreating for Vpp changes). */
  getDrive(): number {
    return this.driveRaw;
  }

  /** Current plate supply voltage (for diagnostics/testing). */
  getScreenVoltage(): number {
    return this.sagVscreen;
  }

  process(input: number): number {
    const driven = input * this.drive;
    if (this.mode === 'tube') {
      // Very gentle makeup gain so it's not super quiet at 0%, but we do not
      // use the aggressive (0.5 / this.drive) because it amplifies power supply ripple.
      // E.g., at drive=0 (driveRaw=0), makeup=2.0. At drive=1, makeup=1.0.
      const makeup = 1.0 + (1.0 - this.driveRaw) * 1.0;
      return this.tubeProcess(driven) * makeup;
    }
    return this.transistorSaturate(driven);
  }

  reset(): void {
    if (this.mode === 'tube') {
      this.solveDCOperatingPoint();
    }
  }

  /** Returns 0-1 saturation depth from the last processed sample. */
  getSaturationDepth(): number {
    return this._saturationDepth;
  }

  // -------------------------------------------------------------------------
  // State-space matrix derivation (DK-method, trapezoidal discretization)
  // -------------------------------------------------------------------------

  /**
   * Derive discrete state-space matrices from circuit topology.
   *
   * Circuit: common-cathode 12AX7 triode stage, 4-node native matrix.
   * C_ga (Miller capacitance) is fully embedded into the KCL equations.
   */
  private initStateSpace(): void {
    const T = 1 / this.fs;
    const { Rp, Rg, Rk, Cc_in, Cc_out, Ck } = this.circuitParams;
    const Rl = AmplifierModel.RLOAD;

    // Companion resistances
    const Rc1 = T / (2 * Cc_in);
    const Rc2 = T / (2 * Cc_out);
    const Rc3 = T / (2 * Ck);
    const Rc4 = T / (2 * AmplifierModel.C_ga);

    const R_in = Rc1 + AmplifierModel.R_source;

    // Node conductance sums for the 2x2 grid-plate system
    const G11 = 1 / R_in + 1 / Rg + 1 / Rc4;
    const G22 = 1 / Rp + 1 / (Rc2 + Rl) + 1 / Rc4;
    const G12 = -1 / Rc4;

    const detG = G11 * G22 - G12 * G12;
    const invG11 = G22 / detG;
    const invG22 = G11 / detG;
    const invG12 = -G12 / detG;

    const G3 = 1 / Rk + 1 / Rc3;

    // V1 coefficients (Grid)
    const c_V1_x1 = invG11 / R_in;
    const c_V1_x2 = invG12 / (Rc2 + Rl);
    const c_V1_x3 = 0;
    const c_V1_x4 = (invG11 - invG12) / Rc4;
    const c_V1_vin = invG11 / R_in;
    const c_V1_vpp = invG12 / Rp;
    const c_V1_Ip = -invG12;
    const c_V1_Ig = -invG11;

    // V2 coefficients (Plate)
    const c_V2_x1 = invG12 / R_in;
    const c_V2_x2 = invG22 / (Rc2 + Rl);
    const c_V2_x3 = 0;
    const c_V2_x4 = (invG12 - invG22) / Rc4;
    const c_V2_vin = invG12 / R_in;
    const c_V2_vpp = invG22 / Rp;
    const c_V2_Ip = -invG22;
    const c_V2_Ig = -invG12;

    // V3 coefficients (Cathode)
    const c_V3_x1 = 0;
    const c_V3_x2 = 0;
    const c_V3_x3 = 1 / (Rc3 * G3);
    const c_V3_x4 = 0;
    const c_V3_vin = 0;
    const c_V3_vpp = 0;
    const c_V3_Ip = 1 / G3;
    const c_V3_Ig = 1 / G3;

    // v_nl = Hd*x + Kd_vin*Vin + Kd_vpp*Vpp + Ld*i_nl
    // Vpk = V2 - V3
    this.Hd[0] = c_V2_x1 - c_V3_x1;
    this.Hd[1] = c_V2_x2 - c_V3_x2;
    this.Hd[2] = c_V2_x3 - c_V3_x3;
    this.Hd[3] = c_V2_x4 - c_V3_x4;
    // Vgk = V1 - V3
    this.Hd[4] = c_V1_x1 - c_V3_x1;
    this.Hd[5] = c_V1_x2 - c_V3_x2;
    this.Hd[6] = c_V1_x3 - c_V3_x3;
    this.Hd[7] = c_V1_x4 - c_V3_x4;

    this.Kd_vin[0] = c_V2_vin - c_V3_vin;
    this.Kd_vin[1] = c_V1_vin - c_V3_vin;

    this.Kd_vpp[0] = c_V2_vpp - c_V3_vpp;
    this.Kd_vpp[1] = c_V1_vpp - c_V3_vpp;

    this.Ld[0] = c_V2_Ip - c_V3_Ip;
    this.Ld[1] = c_V2_Ig - c_V3_Ig;
    this.Ld[2] = c_V1_Ip - c_V3_Ip;
    this.Ld[3] = c_V1_Ig - c_V3_Ig;

    // State update fractions
    const rc1_frac = Rc1 / R_in;
    const rs_frac = AmplifierModel.R_source / R_in;
    const rc_frac = Rc2 / (Rc2 + Rl);
    const rl_frac = Rl / (Rc2 + Rl);

    // x_next = Ad*x + Bd_vin*Vin + Bd_vpp*Vpp + Cd*i_nl
    // x1_next
    this.Ad[0] = 2 * rc1_frac * c_V1_x1 + (2 * rs_frac - 1);
    this.Ad[1] = 2 * rc1_frac * c_V1_x2;
    this.Ad[2] = 2 * rc1_frac * c_V1_x3;
    this.Ad[3] = 2 * rc1_frac * c_V1_x4;

    // x2_next
    this.Ad[4] = 2 * rc_frac * c_V2_x1;
    this.Ad[5] = 2 * rc_frac * c_V2_x2 + (2 * rl_frac - 1);
    this.Ad[6] = 2 * rc_frac * c_V2_x3;
    this.Ad[7] = 2 * rc_frac * c_V2_x4;

    // x3_next
    this.Ad[8] = 2 * c_V3_x1;
    this.Ad[9] = 2 * c_V3_x2;
    this.Ad[10] = 2 * c_V3_x3 - 1;
    this.Ad[11] = 2 * c_V3_x4;

    // x4_next
    this.Ad[12] = 2 * c_V1_x1 - 2 * c_V2_x1;
    this.Ad[13] = 2 * c_V1_x2 - 2 * c_V2_x2;
    this.Ad[14] = 2 * c_V1_x3 - 2 * c_V2_x3;
    this.Ad[15] = 2 * c_V1_x4 - 2 * c_V2_x4 - 1;

    this.Bd_vin[0] = 2 * rc1_frac * c_V1_vin - 2 * rc1_frac;
    this.Bd_vin[1] = 2 * rc_frac * c_V2_vin;
    this.Bd_vin[2] = 2 * c_V3_vin;
    this.Bd_vin[3] = 2 * c_V1_vin - 2 * c_V2_vin;

    this.Bd_vpp[0] = 2 * rc1_frac * c_V1_vpp;
    this.Bd_vpp[1] = 2 * rc_frac * c_V2_vpp;
    this.Bd_vpp[2] = 2 * c_V3_vpp;
    this.Bd_vpp[3] = 2 * c_V1_vpp - 2 * c_V2_vpp;

    this.Cd[0] = 2 * rc1_frac * c_V1_Ip;
    this.Cd[1] = 2 * rc1_frac * c_V1_Ig;
    this.Cd[2] = 2 * rc_frac * c_V2_Ip;
    this.Cd[3] = 2 * rc_frac * c_V2_Ig;
    this.Cd[4] = 2 * c_V3_Ip;
    this.Cd[5] = 2 * c_V3_Ig;
    this.Cd[6] = 2 * c_V1_Ip - 2 * c_V2_Ip;
    this.Cd[7] = 2 * c_V1_Ig - 2 * c_V2_Ig;

    // y = Dd*x + Ed_vpp*Vpp + Fd*i_nl
    this.Dd[0] = c_V2_x1 * rl_frac;
    this.Dd[1] = c_V2_x2 * rl_frac - rl_frac;
    this.Dd[2] = c_V2_x3 * rl_frac;
    this.Dd[3] = c_V2_x4 * rl_frac;

    this.Ed_vpp = c_V2_vpp * rl_frac;

    this.Fd[0] = c_V2_Ip * rl_frac;
    this.Fd[1] = c_V2_Ig * rl_frac;
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
      const Ig = gridCurrentIg(Vgk);

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

    const Ig_dc = gridCurrentIg(-Vk);
    const Ik_dc = Vk / Rk;
    const Ip_dc = Ik_dc - Ig_dc;
    const Vp_dc = Vpp - Ip_dc * Rp;
    this.dcPlateVoltage = Math.max(1, Vp_dc); // Initial guess

    // Initialize capacitor states at DC operating point
    this.x[0] = 0;       // V_Cc_in = 0 (no DC across input coupling cap)
    this.x[1] = Vp_dc;   // V_Cc_out = plate voltage (DC blocked at output)
    this.x[2] = Vk;      // V_Ck = cathode voltage
    this.x[3] = -Vp_dc;  // V_Cga = Vg - Vp = 0 - Vp_dc

    this.i_nl_prev[0] = Ip_dc;
    this.i_nl_prev[1] = Ig_dc;

    // Initialize Sag v2.0 states
    this._sagVpp = Vpp;
    this.sagVscreen = Vpp;
    this.acPhase = 0;

    // Warmup: run the discrete system to its own periodic steady state.
    // 3 seconds ensures the slow SAG v2.0 filter caps fully settle.
    for (let i = 0; i < 48000 * 3; i++) {
      this.tubeProcess(0);
    }

    // Update normalization based on settled rippling state
    const settled_Ip = this.i_nl_prev[0];
    const settled_Vp = this.sagVscreen - settled_Ip * Rp;
    this.dcPlateVoltage = Math.max(1, settled_Vp);

    // Clear any fictitious saturation registered during warmup against the initial guess
    this._saturationDepth = 0;
  }

  // -------------------------------------------------------------------------
  // Per-sample tube processing with Newton-Raphson solver
  // -------------------------------------------------------------------------

  private tubeProcess(u: number): number {
    const x = this.x;
    const Vpp = this.sagVscreen;

    // Newton-Raphson: solve for nonlinear tube currents [Ip, Ig]
    let Ip = this.i_nl_prev[0];
    let Ig = this.i_nl_prev[1];

    for (let iter = 0; iter < 8; iter++) {
      // Tube port voltages: v_nl = Hd*x + Kd_vin*u + Kd_vpp*Vpp + Ld*i_nl
      const Vpk = this.Hd[0] * x[0] + this.Hd[1] * x[1] + this.Hd[2] * x[2] + this.Hd[3] * x[3]
                + this.Kd_vpp[0] * Vpp
                + this.Kd_vin[0] * u
                + this.Ld[0] * Ip + this.Ld[1] * Ig;
      const Vgk = this.Hd[4] * x[0] + this.Hd[5] * x[1] + this.Hd[6] * x[2] + this.Hd[7] * x[3]
                + this.Kd_vpp[1] * Vpp
                + this.Kd_vin[1] * u
                + this.Ld[2] * Ip + this.Ld[3] * Ig;

      // Evaluate tube model at current port voltages
      const Ik_eval = cohenHelieIk(Vpk, Vgk);
      const Ig_eval = gridCurrentIg(Vgk);
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

    // Saturation depth: plate voltage headroom consumed.
    // Use a smaller offset (4%) to prevent the 120Hz AC mains power supply ripple from registering
    // as constant saturation on the UI meter when the amp is idling, but don't suppress real saturation too much.
    const Vp = this.sagVscreen - Ip * this.circuitParams.Rp;
    const rawSat = 1 - Vp / this.dcPlateVoltage;
    this._saturationDepth = Math.max(0, Math.min(1, (rawSat - 0.04) / 0.96));

    // Output: y = Dd*x + Ed_vpp*Vpp + Fd*i_nl
    const y = this.Dd[0] * x[0] + this.Dd[1] * x[1] + this.Dd[2] * x[2] + this.Dd[3] * x[3]
            + this.Ed_vpp * Vpp
            + this.Fd[0] * Ip + this.Fd[1] * Ig;

    // State update: x_next = Ad*x + Bd_vin*u + Bd_vpp*Vpp + Cd*i_nl
    const x0_next = this.Ad[0] * x[0] + this.Ad[1] * x[1] + this.Ad[2] * x[2] + this.Ad[3] * x[3] + this.Bd_vin[0] * u + this.Bd_vpp[0] * Vpp + this.Cd[0] * Ip + this.Cd[1] * Ig;
    const x1_next = this.Ad[4] * x[0] + this.Ad[5] * x[1] + this.Ad[6] * x[2] + this.Ad[7] * x[3] + this.Bd_vin[1] * u + this.Bd_vpp[1] * Vpp + this.Cd[2] * Ip + this.Cd[3] * Ig;
    const x2_next = this.Ad[8] * x[0] + this.Ad[9] * x[1] + this.Ad[10] * x[2] + this.Ad[11] * x[3] + this.Bd_vin[2] * u + this.Bd_vpp[2] * Vpp + this.Cd[4] * Ip + this.Cd[5] * Ig;
    const x3_next = this.Ad[12] * x[0] + this.Ad[13] * x[1] + this.Ad[14] * x[2] + this.Ad[15] * x[3] + this.Bd_vin[3] * u + this.Bd_vpp[3] * Vpp + this.Cd[6] * Ip + this.Cd[7] * Ig;

    this.x[0] = x0_next;
    this.x[1] = x1_next;
    this.x[2] = x2_next;
    this.x[3] = x3_next;

    // Update power supply sag via physical AC mains + rectifier model
    this.updateSag(Ip);

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

    // Unloaded DC is Videal, so peak AC secondary is Videal
    const V_sec_peak = Videal; 

    // Advance AC mains phase (60Hz)
    this.acPhase += 2 * Math.PI * AmplifierModel.SAG_MAINS_FREQ * T;
    if (this.acPhase > 2 * Math.PI) {
      this.acPhase -= 2 * Math.PI;
    }

    // Full-wave rectified AC voltage
    const Vac = V_sec_peak * Math.abs(Math.sin(this.acPhase));

    let Irect = 0;
    if (Vac > Vpp) {
      // 1D Newton solver for physical rectifier diode equation
      // f(I) = I * R_sec + (I / K_rect)^(2/3) - (Vac - Vpp) = 0
      const Vdiff = Vac - Vpp;
      let I = Vdiff / AmplifierModel.SAG_R_SEC; // Initial guess
      for (let i = 0; i < 5; i++) {
        if (I <= 1e-9) { I = 0; break; }
        const tube_drop = Math.pow(I / AmplifierModel.SAG_K_RECT, 2 / 3);
        const f = I * AmplifierModel.SAG_R_SEC + tube_drop - Vdiff;
        const df = AmplifierModel.SAG_R_SEC + (2 / 3) * tube_drop / I;
        const dI = f / df;
        I = Math.max(1e-9, I - dI);
        if (Math.abs(dI) < 1e-6) break;
      }
      Irect = I > 1e-9 ? I : 0;
    }

    const I_filter = (Vpp - Vss) / AmplifierModel.SAG_R_FILTER;

    const dVpp = (Irect - I_filter) / AmplifierModel.SAG_C1;
    const dVss = (I_filter - Ip - Vss / AmplifierModel.SAG_R_BLEEDER) / AmplifierModel.SAG_C2;

    this._sagVpp = Math.max(0, Vpp + T * dVpp);
    this.sagVscreen = Math.max(0, Math.min(this._sagVpp, Vss + T * dVss));
  }

  // -------------------------------------------------------------------------
  // Transistor mode (unchanged)
  // -------------------------------------------------------------------------

  private transistorSaturate(x: number): number {
    const threshold = 0.85;
    const absX = Math.abs(x);
    if (absX < threshold) {
      this._saturationDepth = 0;
      return x;
    }
    const excess = absX - threshold;
    const compressed =
      threshold + (1 - threshold) * Math.tanh(excess / (1 - threshold));
    this._saturationDepth = Math.max(0, Math.min(1, (absX - threshold) / (1 - threshold)));
    return Math.sign(x) * compressed;
  }
}
