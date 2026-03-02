/**
 * Biquad filter utility with Audio EQ Cookbook designs
 * (Robert Bristow-Johnson)
 *
 * All coefficients are normalized (a0 divided out).
 */

/** Normalized biquad filter coefficients (a0 already divided out). */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Second-order IIR (biquad) filter using Direct Form I.
 *
 * y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 */
export class BiquadFilter {
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;

  // Delay-line state
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(coeffs: BiquadCoeffs) {
    this.b0 = coeffs.b0;
    this.b1 = coeffs.b1;
    this.b2 = coeffs.b2;
    this.a1 = coeffs.a1;
    this.a2 = coeffs.a2;
  }

  /** Update coefficients without resetting internal state. */
  updateCoeffs(c: BiquadCoeffs): void {
    this.b0 = c.b0;
    this.b1 = c.b1;
    this.b2 = c.b2;
    this.a1 = c.a1;
    this.a2 = c.a2;
  }

  /** Process a single sample through the filter (Direct Form I). */
  process(x: number): number {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;

    // Shift delay line
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;

    return y;
  }

  /** Clear delay states to zero. */
  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

// ---------------------------------------------------------------------------
// Filter design functions (Audio EQ Cookbook — Robert Bristow-Johnson)
// ---------------------------------------------------------------------------

/**
 * Design a second-order lowpass filter.
 * @param fc  Cutoff frequency in Hz
 * @param fs  Sample rate in Hz
 * @param Q   Quality factor (0.707 = Butterworth)
 */
export function designLowpass(fc: number, fs: number, Q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);

  const b0 = (1 - cosw0) / 2;
  const b1 = 1 - cosw0;
  const b2 = (1 - cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;

  return normalize(b0, b1, b2, a0, a1, a2);
}

/**
 * Design a second-order highpass filter.
 * @param fc  Cutoff frequency in Hz
 * @param fs  Sample rate in Hz
 * @param Q   Quality factor
 */
export function designHighpass(fc: number, fs: number, Q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);

  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;

  return normalize(b0, b1, b2, a0, a1, a2);
}

/**
 * Design a peaking EQ filter.
 * @param fc      Center frequency in Hz
 * @param fs      Sample rate in Hz
 * @param gainDb  Gain in dB (positive = boost, negative = cut)
 * @param Q       Quality factor
 */
export function designPeaking(
  fc: number,
  fs: number,
  gainDb: number,
  Q: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha / A;

  return normalize(b0, b1, b2, a0, a1, a2);
}

/**
 * Design a low-shelf filter.
 * @param fc      Corner frequency in Hz
 * @param fs      Sample rate in Hz
 * @param gainDb  Shelf gain in dB
 * @param Q       Quality factor (controls shelf slope steepness)
 */
export function designLowShelf(
  fc: number,
  fs: number,
  gainDb: number,
  Q: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 - (A - 1) * cosw0 + twoSqrtAAlpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cosw0);
  const b2 = A * (A + 1 - (A - 1) * cosw0 - twoSqrtAAlpha);
  const a0 = A + 1 + (A - 1) * cosw0 + twoSqrtAAlpha;
  const a1 = -2 * (A - 1 + (A + 1) * cosw0);
  const a2 = A + 1 + (A - 1) * cosw0 - twoSqrtAAlpha;

  return normalize(b0, b1, b2, a0, a1, a2);
}

/**
 * Design a high-shelf filter.
 * @param fc      Corner frequency in Hz
 * @param fs      Sample rate in Hz
 * @param gainDb  Shelf gain in dB
 * @param Q       Quality factor (controls shelf slope steepness)
 */
export function designHighShelf(
  fc: number,
  fs: number,
  gainDb: number,
  Q: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cosw0 + twoSqrtAAlpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosw0);
  const b2 = A * (A + 1 + (A - 1) * cosw0 - twoSqrtAAlpha);
  const a0 = A + 1 - (A - 1) * cosw0 + twoSqrtAAlpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosw0);
  const a2 = A + 1 - (A - 1) * cosw0 - twoSqrtAAlpha;

  return normalize(b0, b1, b2, a0, a1, a2);
}

// ---------------------------------------------------------------------------
// First-order filter design (for tape EQ time constants)
// ---------------------------------------------------------------------------

/**
 * Design a first-order section from NAB/IEC time constants via bilinear transform.
 *
 * Implements: H(s) = (1 + s*T_num) / (1 + s*T_den)
 *
 * Stored in BiquadCoeffs with b2=0, a2=0 so the existing BiquadFilter
 * class can run it (y[n] = b0*x[n] + b1*x[n-1] - a1*y[n-1]).
 *
 * @param tNum  Numerator time constant in seconds
 * @param tDen  Denominator time constant in seconds
 * @param fs    Sample rate in Hz
 */
export function designFirstOrderSection(
  tNum: number,
  tDen: number,
  fs: number,
): BiquadCoeffs {
  // Bilinear transform: s → (2fs)(1 - z⁻¹)/(1 + z⁻¹)
  const cn = 2 * fs * tNum;
  const cd = 2 * fs * tDen;

  return {
    b0: (1 + cn) / (1 + cd),
    b1: (1 - cn) / (1 + cd),
    b2: 0,
    a1: (1 - cd) / (1 + cd),
    a2: 0,
  };
}

/**
 * Design a first-order lowpass from a single time constant.
 *
 * Implements: H(s) = 1 / (1 + s*T)
 *
 * @param t   Time constant in seconds
 * @param fs  Sample rate in Hz
 */
export function designFirstOrderLP(t: number, fs: number): BiquadCoeffs {
  const c = 2 * fs * t;
  return {
    b0: 1 / (1 + c),
    b1: 1 / (1 + c),
    b2: 0,
    a1: (1 - c) / (1 + c),
    a2: 0,
  };
}

/**
 * Design a first-order highpass from a single time constant.
 *
 * Implements: H(s) = s*T / (1 + s*T)
 *
 * @param t   Time constant in seconds
 * @param fs  Sample rate in Hz
 */
export function designFirstOrderHP(t: number, fs: number): BiquadCoeffs {
  const c = 2 * fs * t;
  return {
    b0: c / (1 + c),
    b1: -c / (1 + c),
    b2: 0,
    a1: (1 - c) / (1 + c),
    a2: 0,
  };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/** Normalize all coefficients by dividing by a0. */
function normalize(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoeffs {
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}
