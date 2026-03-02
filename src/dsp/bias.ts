/**
 * Bias oscillator — adds an ultrasonic AC bias signal to the audio,
 * simulating the high-frequency bias used in analog tape recording
 * to linearise the magnetic transfer curve.
 */

const TWO_PI = 2 * Math.PI;

/**
 * Base carrier amplitude scaled for the J-A hysteresis model.
 *
 * This is NOT a physical voltage — it's scaled relative to the model's
 * H-field range (~0.5–1.0). The bias must be significant enough to
 * push the operating point through the B-H dead zone and linearize
 * the magnetization curve. A value of 0.5 gives amplitude [0, 0.5]
 * over the standard [0, 1] knob range, matching what the hysteresis
 * model was designed for. The [1, 2] overbias range extends to 1.0.
 */
export const BIAS_CARRIER_BASE = 0.5;

export class BiasOscillator {
  private phaseInc: number;
  private phase = 0;
  private depth = 1.0;
  private readonly sampleRate: number;

  /**
   * @param sampleRate  Audio sample rate in Hz
   * @param biasFreq    Bias oscillator frequency in Hz (default 80 kHz)
   */
  constructor(sampleRate: number, biasFreq = 80000) {
    this.sampleRate = sampleRate;
    // Cap frequency at 0.4 * sampleRate to stay well below Nyquist
    const effectiveFreq = Math.min(biasFreq, 0.4 * sampleRate);
    this.phaseInc = TWO_PI * effectiveFreq / sampleRate;
  }

  /** Set bias oscillator frequency in Hz. */
  setFrequency(freq: number): void {
    const effectiveFreq = Math.min(freq, 0.4 * this.sampleRate);
    this.phaseInc = TWO_PI * effectiveFreq / this.sampleRate;
  }

  /** Set bias depth (clamped to 0-2, allows overbias). */
  setLevel(v: number): void {
    this.depth = Math.max(0, Math.min(2, v));
  }

  /**
   * Process a single sample — adds the bias oscillator output
   * to the input signal.
   */
  process(input: number): number {
    const out = input + Math.sin(this.phase) * BIAS_CARRIER_BASE * this.depth;
    this.phase += this.phaseInc;
    if (this.phase >= TWO_PI) {
      this.phase -= TWO_PI;
    }
    return out;
  }

  /** Reset oscillator phase to zero. */
  reset(): void {
    this.phase = 0;
  }
}
