/**
 * Amplifier waveshaper models for tube and transistor saturation.
 *
 * - Tube mode: Asymmetric soft clipping via biased tanh, producing
 *   even harmonics characteristic of vacuum tube amplifiers.
 * - Transistor mode: Symmetric hard-knee clipping with tanh compression
 *   above a threshold, producing odd harmonics characteristic of
 *   solid-state amplifiers.
 */

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
