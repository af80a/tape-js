/**
 * Bias oscillator — adds an ultrasonic AC bias signal to the audio,
 * simulating the high-frequency bias used in analog tape recording
 * to linearise the magnetic transfer curve.
 */

const TWO_PI = 2 * Math.PI;

export class BiasOscillator {
  private phaseInc: number;
  private phase = 0;
  private level = 0.5;

  /**
   * @param sampleRate  Audio sample rate in Hz
   * @param biasFreq    Bias oscillator frequency in Hz (default 80 kHz)
   */
  constructor(sampleRate: number, biasFreq = 80000) {
    // Cap frequency at 0.4 * sampleRate to stay well below Nyquist
    const effectiveFreq = Math.min(biasFreq, 0.4 * sampleRate);
    this.phaseInc = TWO_PI * effectiveFreq / sampleRate;
  }

  /** Set bias level (clamped to 0-1). */
  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
  }

  /**
   * Process a single sample — adds the bias oscillator output
   * to the input signal.
   */
  process(input: number): number {
    const out = input + Math.sin(this.phase) * this.level * 0.5;
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
