function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Record-side wavelength contour.
 *
 * The hysteresis model already handles the core nonlinear magnetization,
 * but real tape behavior is also wavelength dependent:
 * - long wavelengths (LF) crowd the flux envelope and compress first
 * - short wavelengths (HF) lose level sooner as level rises, especially
 *   at slower speeds and with wider head gaps
 *
 * This stage is intentionally subtle at nominal level and only becomes
 * active as program level rises.
 */
export class WavelengthContour {
  private readonly sampleRate: number;
  private tapeSpeedIps: number;
  private headGapWidth: number;
  private drive = 0.5;
  private saturation = 0.5;
  private coercivity = 0.5;

  private lowAlpha = 0;
  private highAlpha = 0;
  private lowState = 0;
  private highState = 0;
  private lowEnvelope = 0;
  private highEnvelope = 0;

  private readonly envAttackCoeff: number;
  private readonly envReleaseCoeff: number;

  constructor(sampleRate: number, tapeSpeedIps: number, headGapWidth = 2e-6) {
    this.sampleRate = sampleRate;
    this.tapeSpeedIps = Math.max(3.75, tapeSpeedIps);
    this.headGapWidth = Math.max(0.5e-6, headGapWidth);
    this.envAttackCoeff = Math.exp(-1 / (sampleRate * 0.0015));
    this.envReleaseCoeff = Math.exp(-1 / (sampleRate * 0.05));
    this.updateFilters();
  }

  setSpeed(tapeSpeedIps: number): void {
    this.tapeSpeedIps = Math.max(3.75, tapeSpeedIps);
    this.updateFilters();
  }

  setHeadGapWidth(headGapWidth: number): void {
    this.headGapWidth = Math.max(0.5e-6, headGapWidth);
    this.updateFilters();
  }

  setDrive(value: number): void {
    this.drive = clamp(value, 0, 1);
  }

  setSaturation(value: number): void {
    this.saturation = clamp(value, 0, 1);
  }

  setCoercivity(value: number): void {
    this.coercivity = clamp(value, 0.1, 1.0);
  }

  process(input: number): number {
    this.lowState = this.lowState * this.lowAlpha + input * (1 - this.lowAlpha);
    this.highState = this.highState * this.highAlpha + input * (1 - this.highAlpha);

    const lowBand = this.lowState;
    const highBand = input - this.highState;
    const midBand = input - lowBand - highBand;

    const lowAbs = Math.abs(lowBand);
    const highAbs = Math.abs(highBand);
    const lowEnvCoeff = lowAbs > this.lowEnvelope ? this.envAttackCoeff : this.envReleaseCoeff;
    const highEnvCoeff = highAbs > this.highEnvelope ? this.envAttackCoeff : this.envReleaseCoeff;
    this.lowEnvelope = this.lowEnvelope * lowEnvCoeff + lowAbs * (1 - lowEnvCoeff);
    this.highEnvelope = this.highEnvelope * highEnvCoeff + highAbs * (1 - highEnvCoeff);

    const speedPenalty = Math.sqrt(15 / this.tapeSpeedIps);
    const gapPenalty = clamp(Math.sqrt(this.headGapWidth / 2e-6), 0.8, 1.5);
    const robustness = clamp((this.coercivity - 0.45) / 0.1, 0, 1);
    const formulationPenalty = 1.28 - 0.5 * robustness;
    const excitation = (0.35 + 0.4 * ((this.drive + this.saturation) * 0.5)) * formulationPenalty;

    // LF compression rises with long-wavelength energy and tape drive.
    const lowAmount =
      smoothstep((this.lowEnvelope - 0.1) / 0.55) *
      (0.08 + 0.24 * this.saturation) *
      speedPenalty *
      excitation;

    // HF loss rises with short-wavelength energy, slower speeds, and wider gaps.
    const highLossDb =
      smoothstep((this.highEnvelope - 0.035) / 0.24) *
      (0.18 + 0.9 * this.saturation) *
      speedPenalty *
      gapPenalty *
      excitation;

    const lowOut = lowBand / (1 + lowAmount * (0.8 + 1.8 * Math.abs(lowBand)));
    const highOut = highBand * dbToLin(-highLossDb);

    return lowOut + midBand + highOut;
  }

  reset(): void {
    this.lowState = 0;
    this.highState = 0;
    this.lowEnvelope = 0;
    this.highEnvelope = 0;
  }

  private updateFilters(): void {
    const speedNorm = Math.sqrt(this.tapeSpeedIps / 15);
    const lowHz = clamp(120 * speedNorm, 80, 180);
    const highHz = clamp(6_500 * speedNorm * Math.sqrt(2e-6 / this.headGapWidth), 3_200, 9_000);
    this.lowAlpha = Math.exp(-2 * Math.PI * lowHz / this.sampleRate);
    this.highAlpha = Math.exp(-2 * Math.PI * highHz / this.sampleRate);
  }
}
