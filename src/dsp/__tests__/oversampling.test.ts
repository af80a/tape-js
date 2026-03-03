import { describe, it, expect } from 'vitest';
import { Oversampler } from '../oversampling';

describe('Oversampler', () => {
  describe('upsample by factor 2', () => {
    it('doubles the output length', () => {
      const os = new Oversampler(2, 64);
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
      const os = new Oversampler(factor, 256);
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

  describe('Kaiser window stopband rejection', () => {
    it('downsample filter rejects frequencies above base Nyquist', () => {
      const factor = 2;
      const baseLen = 512;
      const os = new Oversampler(factor, baseLen);

      // Inject a tone at 0.375 cycles/sample in the oversampled domain,
      // which is 1.5x the base Nyquist — solidly in the stopband.
      const osLen = baseLen * factor;
      const highRate = new Float32Array(osLen);
      for (let i = 0; i < osLen; i++) {
        highRate[i] = Math.sin(2 * Math.PI * 0.375 * i);
      }

      const output = os.downsample(highRate);
      const steadyState = output.slice(Math.floor(baseLen * 0.5));
      const maxOutput = Math.max(...Array.from(steadyState).map(Math.abs));

      // Kaiser beta=10 gives ~100dB stopband; expect strong attenuation
      expect(maxOutput).toBeLessThan(0.01);
    });
  });

  describe('block-level processing', () => {
    it('handles 128-sample blocks correctly (standard AudioWorklet size)', () => {
      const factor = 2;
      const os = new Oversampler(factor, 128);
      const input = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        input[i] = Math.sin(2 * Math.PI * i / 128);
      }

      const upsampled = os.upsample(input);
      expect(upsampled.length).toBe(128 * factor);

      const output = os.downsample(upsampled);
      expect(output.length).toBe(128);

      // Verify no NaN/Infinity
      for (let i = 0; i < output.length; i++) {
        expect(Number.isFinite(output[i])).toBe(true);
      }
    });

    it('factor 4 block processing produces correct lengths', () => {
      const factor = 4;
      const os = new Oversampler(factor, 128);
      const input = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        input[i] = Math.sin(2 * Math.PI * 3 * i / 128);
      }

      const upsampled = os.upsample(input);
      expect(upsampled.length).toBe(128 * factor);

      const output = os.downsample(upsampled);
      expect(output.length).toBe(128);
    });
  });
});
