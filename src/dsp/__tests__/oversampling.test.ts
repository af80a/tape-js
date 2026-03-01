import { describe, it, expect } from 'vitest';
import { Oversampler } from '../oversampling';

describe('Oversampler', () => {
  describe('upsample by factor 2', () => {
    it('doubles the output length', () => {
      const os = new Oversampler(2);
      const input = new Float32Array(64);
      // Fill with a simple signal
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin(2 * Math.PI * i / 64);
      }

      const upsampled = os.upsample(input);

      expect(upsampled.length).toBe(input.length * 2);
    });
  });

  describe('round-trip recovery', () => {
    it('recovers the original signal shape for low-frequency content', () => {
      const factor = 2;
      const os = new Oversampler(factor);
      const len = 256;
      const input = new Float32Array(len);

      // Low-frequency sine — well below Nyquist so it should survive
      // the round-trip through the anti-aliasing filters.
      for (let i = 0; i < len; i++) {
        input[i] = Math.sin(2 * Math.PI * i / len);
      }

      const upsampled = os.upsample(input);
      const output = os.downsample(upsampled);

      expect(output.length).toBe(len);

      // After the filter transient settles, the peak amplitude of the
      // output should be within 50–150% of the input peak amplitude.
      const maxInput = Math.max(...Array.from(input).map(Math.abs));
      // Skip the first half to let the FIR transient settle
      const steadyState = output.slice(Math.floor(len / 2));
      const maxOutput = Math.max(...Array.from(steadyState).map(Math.abs));

      expect(maxOutput).toBeGreaterThan(maxInput * 0.5);
      expect(maxOutput).toBeLessThan(maxInput * 1.5);
    });
  });

  describe('factor 1 (bypass)', () => {
    it('passes through unchanged — same length and same values', () => {
      const os = new Oversampler(1);
      const input = new Float32Array([0.1, -0.5, 0.3, 0.9, -0.2]);

      const upsampled = os.upsample(input);
      expect(upsampled.length).toBe(input.length);
      for (let i = 0; i < input.length; i++) {
        expect(upsampled[i]).toBe(input[i]);
      }

      const downsampled = os.downsample(input);
      expect(downsampled.length).toBe(input.length);
      for (let i = 0; i < input.length; i++) {
        expect(downsampled[i]).toBe(input[i]);
      }
    });
  });
});
