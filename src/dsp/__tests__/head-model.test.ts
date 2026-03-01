import { describe, it, expect } from 'vitest';
import { HeadModel } from '../head-model';

describe('HeadModel', () => {
  const fs = 44100;
  const tapeSpeed = 15; // ips

  /**
   * Helper: measure steady-state peak amplitude of a sine wave
   * processed through the head model.
   */
  function measurePeak(freq: number): number {
    const model = new HeadModel(fs, tapeSpeed);
    const duration = 2000; // samples
    const settleTime = 500; // samples to skip for transient

    let maxOutput = 0;
    for (let i = 0; i < duration; i++) {
      const x = Math.sin((2 * Math.PI * freq * i) / fs);
      const y = model.process(x);
      if (i >= settleTime) {
        maxOutput = Math.max(maxOutput, Math.abs(y));
      }
    }
    return maxOutput;
  }

  it('head bump boosts LF: 55Hz output >= 90% of 1kHz output', () => {
    const peak55 = measurePeak(55);
    const peak1k = measurePeak(1000);

    // The head bump at ~55Hz should boost low frequencies so that
    // 55Hz output is at least 90% of the 1kHz output level
    expect(peak55).toBeGreaterThanOrEqual(peak1k * 0.9);
  });

  it('gap loss rolls off HF: 15kHz output < 1kHz output', () => {
    const peak15k = measurePeak(15000);
    const peak1k = measurePeak(1000);

    // The gap loss lowpass should attenuate high frequencies
    expect(peak15k).toBeLessThan(peak1k);
  });
});
