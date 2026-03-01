import { describe, it, expect } from 'vitest';
import { TapeEQ } from '../eq-curves';

/**
 * Helper: measure the steady-state peak amplitude of a sine wave
 * after passing through a TapeEQ processor.
 */
function measurePeak(eq: TapeEQ, freq: number, sampleRate: number): number {
  const numSamples = 2000;
  let maxOutput = 0;

  for (let i = 0; i < numSamples; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const y = eq.process(x);
    // Skip the first 500 samples to avoid transient
    if (i >= 500) {
      maxOutput = Math.max(maxOutput, Math.abs(y));
    }
  }

  return maxOutput;
}

describe('TapeEQ', () => {
  const sampleRate = 44100;

  describe('NAB record EQ', () => {
    it('boosts HF: 10kHz output > 100Hz output', () => {
      const eq = new TapeEQ(sampleRate, 'NAB', 7.5, 'record');
      const peak100 = measurePeak(eq, 100, sampleRate);

      eq.reset();
      const peak10k = measurePeak(eq, 10000, sampleRate);

      expect(peak10k).toBeGreaterThan(peak100);
    });
  });

  describe('NAB playback EQ', () => {
    it('cuts HF: 10kHz output < 100Hz output', () => {
      const eq = new TapeEQ(sampleRate, 'NAB', 7.5, 'playback');
      const peak100 = measurePeak(eq, 100, sampleRate);

      eq.reset();
      const peak10k = measurePeak(eq, 10000, sampleRate);

      expect(peak10k).toBeLessThan(peak100);
    });
  });

  describe('IEC mode', () => {
    it('produces no NaN for IEC 7.5 ips record', () => {
      const eq = new TapeEQ(sampleRate, 'IEC', 7.5, 'record');

      for (let i = 0; i < 1000; i++) {
        const x = Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
        const y = eq.process(x);
        expect(y).not.toBeNaN();
      }
    });
  });
});
