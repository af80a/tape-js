import { describe, it, expect } from 'vitest';
import {
  BiquadFilter,
  designLowpass,
  designPeaking,
} from '../biquad';

describe('BiquadFilter', () => {
  describe('Lowpass filter', () => {
    it('passes DC (output converges to ~1.0 for constant input of 1.0)', () => {
      // Design a lowpass at 1kHz, sampleRate 44100, Q = 0.707
      const coeffs = designLowpass(1000, 44100, 0.707);
      const filter = new BiquadFilter(coeffs);

      let output = 0;
      for (let i = 0; i < 100; i++) {
        output = filter.process(1.0);
      }

      // DC signal should pass through a lowpass filter with unity gain
      expect(output).toBeCloseTo(1.0, 2);
    });

    it('attenuates well above cutoff (10kHz signal through 1kHz LPF)', () => {
      const coeffs = designLowpass(1000, 44100, 0.707);
      const filter = new BiquadFilter(coeffs);

      const fs = 44100;
      const freq = 10000; // well above 1kHz cutoff

      // Run the filter for enough samples to reach steady-state
      let maxOutput = 0;
      for (let i = 0; i < 1000; i++) {
        const x = Math.sin(2 * Math.PI * freq * i / fs);
        const y = filter.process(x);
        // Only look at steady-state (skip first 100 samples for transient)
        if (i >= 100) {
          maxOutput = Math.max(maxOutput, Math.abs(y));
        }
      }

      // 10kHz through a 1kHz LPF should be heavily attenuated
      expect(maxOutput).toBeLessThan(0.2);
    });
  });

  describe('Peaking filter', () => {
    it('boosts at center frequency (+6dB ~ 2x amplitude)', () => {
      const fs = 44100;
      const fc = 1000;
      const gainDb = 6;
      const Q = 1.0;

      const coeffs = designPeaking(fc, fs, gainDb, Q);
      const filter = new BiquadFilter(coeffs);

      // Send a sine wave at the center frequency through the filter
      let maxOutput = 0;
      for (let i = 0; i < 2000; i++) {
        const x = Math.sin(2 * Math.PI * fc * i / fs);
        const y = filter.process(x);
        // Check steady-state only
        if (i >= 500) {
          maxOutput = Math.max(maxOutput, Math.abs(y));
        }
      }

      // +6dB should result in roughly 2x amplitude (10^(6/20) ~ 1.995)
      // Allow some tolerance for filter transients
      expect(maxOutput).toBeGreaterThan(1.8);
      expect(maxOutput).toBeLessThan(2.2);
    });
  });

  describe('reset()', () => {
    it('clears filter state to match a fresh filter', () => {
      const coeffs = designLowpass(1000, 44100, 0.707);
      const filter = new BiquadFilter(coeffs);

      // Process some samples to build up internal state
      for (let i = 0; i < 50; i++) {
        filter.process(Math.random());
      }

      // Reset the filter
      filter.reset();

      // Create a fresh filter with the same coefficients
      const freshFilter = new BiquadFilter(coeffs);

      // Both should produce identical output for the same input sequence
      const testInput = [0.5, -0.3, 0.8, -0.1, 0.6];
      for (const x of testInput) {
        const y1 = filter.process(x);
        const y2 = freshFilter.process(x);
        expect(y1).toBeCloseTo(y2, 10);
      }
    });
  });
});
