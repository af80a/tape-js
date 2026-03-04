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
  private modShape: BiquadFilter;
  private level = 0.5;
  private envelope = 0;
  private prevSignal = 0;
  private readonly envCoeff: number;

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

    // Modulation noise shaping: broader mid-frequency content
    this.modShape = new BiquadFilter(
      designPeaking(2000, sampleRate, 4, 1.0),
    );

    // Envelope follower: ~5 ms attack/release for signal tracking
    this.envCoeff = 1 - Math.exp(-1 / (sampleRate * 0.005));
  }

  /** Set noise level (clamped to 0-1). */
  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
  }

  /**
   * Generate one sample of shaped tape noise.
   *
   * @param signalLevel  Absolute signal level (0-1+) for modulation noise.
   *                     When omitted, only the constant bias noise is produced.
   * Returns 0 when level is effectively zero.
   */
  process(signalLevel?: number): number {
    if (this.level < 0.001) return 0;

    // White noise source
    const white = Math.random() * 2 - 1;

    // Bias noise: constant hiss shaped by peaking + HPF
    let y = this.shape.process(white);
    y = this.hpf.process(y);
    y *= this.level * 0.01;

    // Modulation (Barkhausen) noise: signal-dependent component.
    // Magnetic domain irregularities (Barkhausen jumps) cause noise proportional
    // to the rate of change of the magnetic field (dH/dt) and absolute level.
    if (signalLevel !== undefined) {
      const dHdt = Math.abs(signalLevel - this.prevSignal);
      this.prevSignal = signalLevel;
      
      // Envelope tracks the rate of change (transients cause most Barkhausen noise)
      // combined with a small amount of absolute level.
      const excitation = dHdt * 15.0 + Math.abs(signalLevel) * 0.1;
      this.envelope += this.envCoeff * (excitation - this.envelope);

      // Second independent white noise source for modulation
      const modWhite = Math.random() * 2 - 1;
      let modNoise = this.modShape.process(modWhite);
      
      // Barkhausen noise is extremely gritty/chuffing. Scale it up.
      modNoise *= this.envelope * this.level * 0.04;
      y += modNoise;
    }

    return y;
  }

  /** Reset filter states and envelope. */
  reset(): void {
    this.shape.reset();
    this.hpf.reset();
    this.modShape.reset();
    this.envelope = 0;
  }
}
