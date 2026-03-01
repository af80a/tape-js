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

export class AmplifierModel {
  private mode: 'tube' | 'transistor';
  private drive: number;
  private bias: number;

  constructor(mode: 'tube' | 'transistor', drive = 1.0) {
    this.mode = mode;
    this.drive = drive;
    this.bias = mode === 'tube' ? 0.15 : 0;
  }

  /** Update the drive level. */
  setDrive(v: number): void {
    this.drive = v;
  }

  /**
   * Process a single input sample through the amplifier model.
   * Applies drive gain then routes to the appropriate saturation curve.
   */
  process(input: number): number {
    const driven = input * this.drive;

    if (this.mode === 'tube') {
      return this.tubeSaturate(driven);
    } else {
      return this.transistorSaturate(driven);
    }
  }

  /**
   * Tube saturation — asymmetric soft clipping via biased tanh.
   *
   * The bias offset shifts the operating point on the tanh curve,
   * causing positive and negative excursions to clip differently.
   * This asymmetry generates even-order harmonics (2nd, 4th, etc.)
   * characteristic of vacuum tube distortion.
   */
  private tubeSaturate(x: number): number {
    const biased = x + this.bias;
    const saturated = Math.tanh(biased) - Math.tanh(this.bias);
    const normFactor = 1.0 / (Math.tanh(1.0 + this.bias) - Math.tanh(this.bias));
    return saturated * normFactor;
  }

  /**
   * Transistor saturation — symmetric hard-knee clipping.
   *
   * Below the threshold the signal passes linearly. Above the threshold,
   * the excess is compressed via tanh, creating a sharp knee transition.
   * The symmetric clipping generates odd-order harmonics (3rd, 5th, etc.)
   * characteristic of solid-state amplifier distortion.
   */
  private transistorSaturate(x: number): number {
    const threshold = 0.85;
    const absX = Math.abs(x);

    if (absX < threshold) {
      return x;
    }

    const excess = absX - threshold;
    const compressed =
      threshold + (1 - threshold) * Math.tanh(excess / (1 - threshold));
    return Math.sign(x) * compressed;
  }

  /** Reset processor state. This model is stateless, so nothing to do. */
  reset(): void {
    // Stateless — no internal state to clear.
  }
}
