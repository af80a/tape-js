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

import {
  BiquadFilter,
  designFirstOrderSection,
} from './biquad';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tape EQ standard. */
export type EQStandard = 'NAB' | 'IEC';

/** Tape speed in inches per second. */
export type TapeSpeed = 15 | 7.5 | 3.75;

/** EQ application mode. */
export type EQMode = 'record' | 'playback';

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
  T2: number;        // HF time constant in µs
}

const TIME_CONSTANTS: Record<EQStandard, Record<TapeSpeed, TimeConstants>> = {
  NAB: {
    15:   { T1: 3180, T2: 50 },
    7.5:  { T1: 3180, T2: 50 },
    3.75: { T1: 3180, T2: 90 },
  },
  IEC: {
    15:   { T1: null, T2: 35 },
    7.5:  { T1: null, T2: 70 },
    3.75: { T1: null, T2: 90 },
  },
};

// ---------------------------------------------------------------------------
// TapeEQ class
// ---------------------------------------------------------------------------

/**
 * Tape equalization processor using first-order IIR filters.
 *
 * For NAB (two time constants): a single first-order section implements
 * H(s) = (1 + s*T_num)/(1 + s*T_den) via bilinear transform, giving
 * one pole, one zero, and a continuous 6 dB/oct transition.
 *
 * For IEC (one time constant): a first-order LP (playback) or HP (record)
 * implements the single time constant, with unity DC or HF gain.
 *
 * Both are normalized at 1 kHz for practical signal levels.
 */
export class TapeEQ {
  private filter: BiquadFilter;
  private normGain: number;

  /**
   * @param sampleRate Audio sample rate in Hz
   * @param standard   EQ standard ('NAB' or 'IEC')
   * @param speed      Tape speed in ips (15, 7.5, or 3.75)
   * @param mode       'record' (pre-emphasis) or 'playback' (de-emphasis)
   */
  constructor(
    sampleRate: number,
    standard: EQStandard,
    speed: TapeSpeed,
    mode: EQMode,
  ) {
    const tc = TIME_CONSTANTS[standard][speed];

    // Convert µs to seconds
    const T2 = tc.T2 * 1e-6;

    // For IEC (T1 = null), we need a limiting time constant to make the
    // record transfer function proper (realizable). Both record and playback
    // use the same T_lim so they perfectly complement each other.
    const tLim = 1 / (2 * Math.PI * 0.45 * sampleRate);

    // Determine numerator and denominator time constants.
    // NAB: H(s) = (1 + s*T_num) / (1 + s*T_den)
    //   Record:   T_num = T1, T_den = T2  (HF boost)
    //   Playback: T_num = T2, T_den = T1  (HF cut)
    //
    // IEC: Only T2 exists. Use tLim as the complementary constant.
    //   Record:   T_num = T2,   T_den = tLim  (HF boost)
    //   Playback: T_num = tLim, T_den = T2    (HF cut)
    const T1 = tc.T1 !== null ? tc.T1 * 1e-6 : tLim;

    let tNum: number;
    let tDen: number;
    if (mode === 'record') {
      tNum = tc.T1 !== null ? T1 : T2;   // NAB: T1, IEC: T2
      tDen = tc.T1 !== null ? T2 : tLim; // NAB: T2, IEC: tLim
    } else {
      tNum = tc.T1 !== null ? T2 : tLim; // NAB: T2, IEC: tLim
      tDen = tc.T1 !== null ? T1 : T2;   // NAB: T1, IEC: T2
    }

    this.filter = new BiquadFilter(designFirstOrderSection(tNum, tDen, sampleRate));

    // Normalize at 1 kHz: compute analog magnitude and invert
    const w1k = 2 * Math.PI * 1000;
    const magSq = (1 + (w1k * tNum) ** 2) / (1 + (w1k * tDen) ** 2);
    this.normGain = 1 / Math.sqrt(magSq);
  }

  /**
   * Process a single sample through the EQ filter.
   * The normalization gain is applied inline for efficiency.
   */
  process(input: number): number {
    return this.filter.process(input) * this.normGain;
  }

  /** Reset filter state. */
  reset(): void {
    this.filter.reset();
  }
}
