import { describe, it, expect } from 'vitest';
import { Oversampler } from '../oversampling';

describe('Oversampler pre-allocation', () => {
  it('upsample returns pre-allocated buffer (same reference on repeated calls)', () => {
    const os = new Oversampler(2);
    const input = new Float32Array([0.5]);

    const result1 = os.upsample(input);
    const result2 = os.upsample(input);

    // Should return the same pre-allocated buffer, not a new allocation each time
    expect(result1).toBe(result2);
  });

  it('downsample returns pre-allocated buffer (same reference on repeated calls)', () => {
    const os = new Oversampler(2);
    const input = new Float32Array([0.1, 0.2]);

    const result1 = os.downsample(input);
    const result2 = os.downsample(input);

    // Should return the same pre-allocated buffer
    expect(result1).toBe(result2);
  });

  it('bypass mode (factor=1) returns input directly', () => {
    const os = new Oversampler(1);
    const input = new Float32Array([0.5]);
    expect(os.upsample(input)).toBe(input);
    expect(os.downsample(input)).toBe(input);
  });

  it('4x oversampler returns correct-length pre-allocated buffers', () => {
    const os = new Oversampler(4);
    const input = new Float32Array([0.5]);

    const up = os.upsample(input);
    expect(up.length).toBe(4);

    const down = os.downsample(up);
    expect(down.length).toBe(1);
  });
});
