/**
 * Tape noise generator — shaped white noise that mimics the hiss
 * character of analog tape.
 *
 * Two filters shape the spectral content:
 * 1. A peaking boost at 4 kHz gives the noise its characteristic
 *    "tape hiss" brightness.
 * 2. A highpass at 200 Hz removes low-frequency rumble.
 */

import { BiquadFilter, designPeaking, designHighpass } from './biquad';

export class TapeNoise {
  private shape: BiquadFilter;
  private hpf: BiquadFilter;
  private level = 0.5;

  /** @param sampleRate  Audio sample rate in Hz */
  constructor(sampleRate: number) {
    // Shape filter: peaking boost at 4 kHz, +6 dB, Q = 1.5
    this.shape = new BiquadFilter(
      designPeaking(4000, sampleRate, 6, 1.5),
    );

    // High-pass filter: 200 Hz, Q = 0.707 (Butterworth)
    this.hpf = new BiquadFilter(
      designHighpass(200, sampleRate, 0.707),
    );
  }

  /** Set noise level (clamped to 0-1). */
  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
  }

  /**
   * Generate one sample of shaped tape noise.
   * Returns 0 when level is effectively zero.
   */
  process(): number {
    if (this.level < 0.001) return 0;

    // White noise source
    const white = Math.random() * 2 - 1;

    // Shape: peaking -> HPF
    let y = this.shape.process(white);
    y = this.hpf.process(y);

    return y * this.level * 0.01;
  }

  /** Reset filter states. */
  reset(): void {
    this.shape.reset();
    this.hpf.reset();
  }
}
