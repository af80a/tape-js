/**
 * Tape equalization curves for NAB and IEC standards.
 *
 * Implements pre-emphasis (record) and de-emphasis (playback) EQ
 * using standard time constants for different tape speeds.
 */

import { BiquadFilter, designHighShelf, designLowShelf } from './biquad';

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
 * T1 = low-frequency time constant (null means no LF EQ, as in IEC).
 * T2 = high-frequency time constant.
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a time constant in microseconds to a corner frequency in Hz.
 * f = 1e6 / (2 * pi * T_µs)
 */
function cornerFrequency(timeConstantUs: number): number {
  return 1e6 / (2 * Math.PI * timeConstantUs);
}

/**
 * Clamp a frequency to at most 0.45 * sampleRate to stay safely
 * below Nyquist and avoid numerical instability in biquad design.
 */
function clampFrequency(freq: number, sampleRate: number): number {
  return Math.min(freq, 0.45 * sampleRate);
}

// ---------------------------------------------------------------------------
// TapeEQ class
// ---------------------------------------------------------------------------

/** HF and LF shelf gains used for record/playback EQ. */
const HF_GAIN_DB = 10;
const LF_GAIN_DB = 6;
const Q = 0.707;

/**
 * Tape equalization processor.
 *
 * Applies high-shelf (and optionally low-shelf) filtering based on
 * the NAB or IEC standard time constants for the chosen tape speed.
 */
export class TapeEQ {
  private hfFilter: BiquadFilter;
  private lfFilter: BiquadFilter | null;

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

    // HF shelf -----------------------------------------------------------
    const hfCorner = clampFrequency(cornerFrequency(tc.T2), sampleRate);
    const hfGain = mode === 'record' ? HF_GAIN_DB : -HF_GAIN_DB;
    const hfCoeffs = designHighShelf(hfCorner, sampleRate, hfGain, Q);
    this.hfFilter = new BiquadFilter(hfCoeffs);

    // LF shelf (NAB only) ------------------------------------------------
    if (tc.T1 !== null) {
      const lfCorner = clampFrequency(cornerFrequency(tc.T1), sampleRate);
      const lfGain = mode === 'record' ? -LF_GAIN_DB : LF_GAIN_DB;
      const lfCoeffs = designLowShelf(lfCorner, sampleRate, lfGain, Q);
      this.lfFilter = new BiquadFilter(lfCoeffs);
    } else {
      this.lfFilter = null;
    }
  }

  /**
   * Process a single sample through the EQ chain.
   * Applies HF shelf first, then LF shelf if present.
   */
  process(input: number): number {
    let output = this.hfFilter.process(input);
    if (this.lfFilter !== null) {
      output = this.lfFilter.process(output);
    }
    return output;
  }

  /** Reset all filter states. */
  reset(): void {
    this.hfFilter.reset();
    if (this.lfFilter !== null) {
      this.lfFilter.reset();
    }
  }
}
