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
 * Record-bias contour model.
 *
 * Real tape alignment is a tradeoff:
 * - underbias preserves or exaggerates HF but increases distortion
 * - overbias linearizes the tape but shaves HF, especially at slower speeds
 *
 * This stage models the missing HF side of that tradeoff with a dynamic
 * complementary low/high split whose high band gain depends on bias offset
 * from the machine's nominal alignment, signal level, and tape speed.
 */
export class BiasContour {
  private readonly sampleRate: number;
  private tapeSpeedIps: number;
  private nominalBias: number;
  private currentBias: number;

  private contourAlpha = 0;
  private lowState = 0;
  private envelope = 0;

  private readonly envAttackCoeff: number;
  private readonly envReleaseCoeff: number;

  constructor(sampleRate: number, tapeSpeedIps: number, nominalBias = 0.5) {
    this.sampleRate = sampleRate;
    this.tapeSpeedIps = Math.max(3.75, tapeSpeedIps);
    this.nominalBias = clamp(nominalBias, 0, 1);
    this.currentBias = this.nominalBias;
    this.envAttackCoeff = Math.exp(-1 / (sampleRate * 0.002));
    this.envReleaseCoeff = Math.exp(-1 / (sampleRate * 0.04));
    this.updateContourCoeff();
  }

  setSpeed(tapeSpeedIps: number): void {
    this.tapeSpeedIps = Math.max(3.75, tapeSpeedIps);
    this.updateContourCoeff();
  }

  setNominalBias(value: number): void {
    this.nominalBias = clamp(value, 0, 1);
  }

  setBias(value: number): void {
    this.currentBias = clamp(value, 0, 1);
  }

  process(input: number): number {
    const absInput = Math.abs(input);
    const envCoeff = absInput > this.envelope ? this.envAttackCoeff : this.envReleaseCoeff;
    this.envelope = this.envelope * envCoeff + absInput * (1 - envCoeff);

    this.lowState = this.lowState * this.contourAlpha + input * (1 - this.contourAlpha);
    const highBand = input - this.lowState;

    const overbias = this.normalizedOverbias();
    const underbias = this.normalizedUnderbias();
    const levelWeight = smoothstep((this.envelope - 0.18) / 0.52);
    const speedPenalty = Math.sqrt(15 / this.tapeSpeedIps);

    // Calibrated around the machine's aligned point:
    // nominal bias is effectively transparent, while misalignment only shifts
    // the top end by a few dB at the extremes instead of acting like a tone knob.
    const overbiasLossDb = overbias * (0.2 + 0.95 * levelWeight) * speedPenalty;
    const underbiasLiftDb = underbias * (0.05 + 0.25 * (1 - levelWeight * 0.35));
    const hfGain = clamp(
      dbToLin(underbiasLiftDb - overbiasLossDb),
      dbToLin(-2.4),
      dbToLin(0.75),
    );

    return this.lowState + highBand * hfGain;
  }

  reset(): void {
    this.lowState = 0;
    this.envelope = 0;
  }

  private normalizedOverbias(): number {
    const headroom = Math.max(1e-6, 1 - this.nominalBias);
    return clamp((this.currentBias - this.nominalBias) / headroom, 0, 1);
  }

  private normalizedUnderbias(): number {
    const range = Math.max(1e-6, this.nominalBias);
    return clamp((this.nominalBias - this.currentBias) / range, 0, 1);
  }

  private updateContourCoeff(): void {
    const contourHz = clamp(6_800 * Math.sqrt(this.tapeSpeedIps / 15), 3_500, 8_500);
    this.contourAlpha = Math.exp(-2 * Math.PI * contourHz / this.sampleRate);
  }
}
