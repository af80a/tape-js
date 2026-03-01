/**
 * Tape head frequency-response model.
 *
 * Models three phenomena:
 * 1. Head bump — a low-frequency resonance peak whose frequency
 *    scales with tape speed.
 * 2. Head-bump dip — a slight dip at twice the bump frequency.
 * 3. Gap loss — a gentle high-frequency roll-off caused by the
 *    finite width of the playback head gap.
 */

import { BiquadFilter, designPeaking, designLowpass } from './biquad';

export class HeadModel {
  private bump: BiquadFilter;
  private dip: BiquadFilter;
  private gapLoss: BiquadFilter;

  /**
   * @param sampleRate  Audio sample rate in Hz
   * @param tapeSpeedIps  Tape speed in inches per second (e.g. 15)
   */
  constructor(sampleRate: number, tapeSpeedIps: number) {
    const maxFreq = 0.45 * sampleRate;

    // Head bump: peaking boost at tapeSpeed * 3.67 Hz
    const bumpFreq = Math.min(tapeSpeedIps * 3.67, maxFreq);
    this.bump = new BiquadFilter(
      designPeaking(bumpFreq, sampleRate, 3.0, 2.0),
    );

    // Dip at twice the bump frequency
    const dipFreq = Math.min(bumpFreq * 2, maxFreq);
    this.dip = new BiquadFilter(
      designPeaking(dipFreq, sampleRate, -1.5, 1.5),
    );

    // Gap loss: lowpass at tapeSpeed * 1200 Hz
    const gapFreq = Math.min(tapeSpeedIps * 1200, maxFreq);
    this.gapLoss = new BiquadFilter(
      designLowpass(gapFreq, sampleRate, 0.6),
    );
  }

  /** Process a single sample: bump -> dip -> gapLoss. */
  process(input: number): number {
    let y = this.bump.process(input);
    y = this.dip.process(y);
    y = this.gapLoss.process(y);
    return y;
  }

  /** Reset all internal filter states. */
  reset(): void {
    this.bump.reset();
    this.dip.reset();
    this.gapLoss.reset();
  }
}
