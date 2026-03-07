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

  // Per-instance xorshift32 PRNG for independent per-channel noise.
  // Avoids global Math.random() which couples channels' noise sequences.
  private prngState: number;

  /**
   * @param sampleRate  Audio sample rate in Hz
   * @param seed        PRNG seed for per-channel independence (use channel index)
   */
  constructor(sampleRate: number, seed = 0) {
    this.prngState = 1 + seed * 196613;
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
   *
   * @param signalLevel  Unused placeholder kept for API compatibility while the
   *                     model stays limited to stationary hiss.
   * Returns 0 when level is effectively zero.
   */
  // signalLevel intentionally accepted but not used: the current model only
  // represents stationary hiss until a measured signal-dependent noise model exists.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  process(signalLevel?: number): number {
    if (this.level < 0.001) return 0;

    // White noise source
    const white = this.nextNoise();

    // Bias noise: constant hiss shaped by peaking + HPF
    let y = this.shape.process(white);
    y = this.hpf.process(y);
    y *= this.level * 0.01;

    return y;
  }

  /** Xorshift32 PRNG returning a value in [-1, 1]. */
  private nextNoise(): number {
    let x = this.prngState | 0;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.prngState = x;
    return (x | 0) / 0x7FFFFFFF;
  }

  /** Reset filter states, envelope, and signal tracking. */
  reset(): void {
    this.shape.reset();
    this.hpf.reset();
  }
}
