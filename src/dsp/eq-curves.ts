/**
 * Tape equalization curves for NAB and IEC standards.
 *
 * Implements pre-emphasis (record) and de-emphasis (playback) EQ
 * using first-order pole/zero filters derived from the standard
 * time constants via bilinear transform.
 *
 * NAB: H(s) = (1 + s*T1) / (1 + s*T2)   — two time constants
 *   Record (pre-emphasis): T_num = T1, T_den = T2 → boosts HF
 *   Playback (de-emphasis): T_num = T2, T_den = T1 → cuts HF
 *
 * IEC/CCIR: Only one time constant T2; no LF shelf.
 *   Playback: H(s) = 1 / (1 + s*T2)  — first-order LP
 *   Record:   H(s) = (1 + s*T2) — first-order HP (with HF limiting pole)
 *
 * The transfer function is normalized at 1 kHz for unity gain at
 * the reference frequency, keeping signal levels practical in
 * the processing chain.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tape EQ standard. */
export type EQStandard = "NAB" | "IEC";

/** Tape speed in inches per second. */
export type TapeSpeed = 30 | 15 | 7.5 | 3.75;

/** EQ application mode. */
export type EQMode = "record" | "playback";

// ---------------------------------------------------------------------------
// Time constants table
// ---------------------------------------------------------------------------

/**
 * Time constants in microseconds for each standard/speed combination.
 * T1 = low-frequency time constant (null means no LF shelf, as in IEC).
 * T2 = high-frequency time constant.
 *
 * Sources: IEC 60094, NAB standard, IASA TC-04 §5.4.10
 */
interface TimeConstants {
  T1: number | null; // LF time constant in µs
  T2: number; // HF time constant in µs
}

const TIME_CONSTANTS: Record<EQStandard, Record<TapeSpeed, TimeConstants>> = {
  NAB: {
    30: { T1: null, T2: 17.5 },
    15: { T1: 3180, T2: 50 },
    7.5: { T1: 3180, T2: 50 },
    3.75: { T1: 3180, T2: 90 },
  },
  IEC: {
    30: { T1: null, T2: 17.5 },
    15: { T1: null, T2: 35 },
    7.5: { T1: null, T2: 70 },
    3.75: { T1: null, T2: 90 },
  },
};

const MASTERING_30_IPS: TimeConstants = { T1: null, T2: 17.5 };

// ---------------------------------------------------------------------------
// TapeEQ class
// ---------------------------------------------------------------------------
/**
 * State-of-the-art Tape Equalization using Topology-Preserving Transform (TPT).
 *
 * Instead of standard discrete Biquads with 1-sample feedback delays, this uses
 * Zero-Delay Feedback (ZDF) to explicitly model the analog RC circuit topology.
 *
 * Benefits:
 * 1. Absolute numerical stability, even at extreme low frequencies (NAB 50Hz pole).
 * 2. Can be modulated continuously at audio rates without clicking (ideal for
 *    linking EQ cutoff shifting to wow/flutter tape speed modulation).
 * 3. Exact analog magnitude matching via pole/zero blending.
 */
export class TapeEQ {
  private normGain: number = 1;

  // Analog Time Constants
  private tNum!: number;
  private tDen!: number;
  private tNumStandard!: number;
  private tDenStandard!: number; // Unmodified T2 pole for color scaling
  private colorUsesRecordZero = false;
  private readonly sampleRate: number;

  // TPT Filter State
  private s = 0; // State variable (capacitor charge)
  private g = 0; // Pre-warped conductance
  private hfBlendRatio = 0;

  private standard: EQStandard;
  private speed: TapeSpeed;
  private mode: EQMode;

  constructor(
    sampleRate: number,
    standard: EQStandard,
    speed: TapeSpeed,
    mode: EQMode,
  ) {
    this.sampleRate = sampleRate;
    this.standard = standard;
    this.speed = speed;
    this.mode = mode;

    this.calculateTimeConstants();
  }

  /**
   * Set tape speed to update EQ time constants without recreating the filter.
   */
  setSpeed(speed: TapeSpeed): void {
    if (this.speed === speed) return;
    this.speed = speed;
    this.calculateTimeConstants();
  }

  private calculateTimeConstants(): void {
    // 30 ips is treated as the fixed modern mastering curve (AES / IEC2, 17.5 µs)
    // regardless of the legacy NAB/IEC selector, matching common mastering practice.
    const tc = this.speed === 30 ? MASTERING_30_IPS : TIME_CONSTANTS[this.standard][this.speed];

    const T2 = tc.T2 * 1e-6;
    const tLim = 1 / (2 * Math.PI * 0.45 * this.sampleRate); // HF limit to prevent Nyquist blowout
    const T1 = tc.T1 !== null ? tc.T1 * 1e-6 : tLim;

    // Determine Numerator (Zero) and Denominator (Pole) time constants
    if (this.mode === "record") {
      this.tNum = tc.T1 !== null ? T1 : T2;
      this.tDen = tc.T1 !== null ? T2 : tLim;
    } else {
      this.tNum = tc.T1 !== null ? T2 : tLim;
      this.tDen = tc.T1 !== null ? T1 : T2;
    }
    this.colorUsesRecordZero = this.mode === 'record' && tc.T1 === null;

    // @ts-ignore - allow readonly override during setup
    this.tNumStandard = this.tNum;
    // @ts-ignore
    this.tDenStandard = this.tDen;

    this.updateCoefficients();
  }

  /**
   * Updates the TPT filter conductance from the current tDen.
   * Safe to call every sample — no state discontinuity, no clicks.
   * Exposed publicly for wow/flutter tape-speed modulation in the processor.
   */
  updateCoefficients(): void {
    // Cutoff frequency derived from the denominator time constant
    const cutoffHz = 1.0 / (2.0 * Math.PI * this.tDen);
    const wa = 2.0 * Math.PI * cutoffHz;
    this.g = Math.tan((wa * 0.5) / this.sampleRate);

    // Cutoff frequency derived from the numerator time constant
    const zeroHz = 1.0 / (2.0 * Math.PI * this.tNum);
    const waZero = 2.0 * Math.PI * zeroHz;
    const g_num = Math.tan((waZero * 0.5) / this.sampleRate);

    // Use double pre-warping ratio so Record and Playback are exact digital inverses
    this.hfBlendRatio = this.g / g_num;

    // Digital normalization at 1 kHz for exact unity gain
    const tan1k = Math.tan((Math.PI * 1000) / this.sampleRate);
    const num1k = 1 + Math.pow(tan1k / g_num, 2);
    const den1k = 1 + Math.pow(tan1k / this.g, 2);
    this.normGain = 1 / Math.sqrt(num1k / den1k);
  }

  /**
   * Shift the HF pre-emphasis pole frequency for tonal coloration.
   *
   * v = 0   → standard alignment (e.g. NAB T2 = 50 µs → pole at 3.2 kHz)
   * v = +1  → brighter: pole at 2× frequency (T2 halved, e.g. 25 µs → 6.4 kHz)
   *            After standard playback de-emphasis: ~+3–4 dB shelf above 3 kHz.
   * v = -1  → darker:  pole at ½ frequency (T2 doubled, e.g. 100 µs → 1.6 kHz)
   *            After standard playback de-emphasis: ~-3–4 dB shelf above 1.5 kHz.
   *
   * Physically this models deliberate record-head alignment deviation —
   * what engineers did to give a machine its characteristic tonal signature.
   */
  setColor(v: number): void {
    const clamped = Math.max(-1, Math.min(1, v));
    if (this.colorUsesRecordZero) {
      // Single-time-constant record curves (IEC and 30 ips mastering) expose
      // color by moving the HF boost zero, not the limiter pole.
      this.tNum = this.tNumStandard * Math.pow(2, clamped);
    } else {
      // NAB / IEC playback: tDen is the HF pole. Decreasing it raises the pole
      // frequency → HF boost extends further → brighter.
      this.tDen = this.tDenStandard * Math.pow(2, -clamped);
    }
    this.updateCoefficients();
  }

  /** Process a single sample through the continuous TPT analog model */
  process(input: number): number {
    // 1. Calculate the voltage across the modeled RC capacitor
    const v = (input - this.s) * (this.g / (1.0 + this.g));

    // 2. Extract the continuous low-pass and high-pass states
    const yLP = v + this.s; // Low-pass output
    const yHP = input - yLP; // High-pass output (exactly complementary)

    // 3. Update the analog capacitor state (Trapezoidal integration)
    this.s += 2.0 * v;

    // Anti-denormalization for absolute silence
    if (Math.abs(this.s) < 1e-12) this.s = 0;

    // 4. Construct the complex EQ Curve
    const output = yLP + this.hfBlendRatio * yHP;

    return output * this.normGain;
  }

  /** Reset the analog capacitor state. */
  reset(): void {
    this.s = 0;
  }
}
