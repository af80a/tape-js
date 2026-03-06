import { describe, expect, it } from 'vitest';
import { analyzeInputAlignment } from '../input-normalization';

function dbfsRmsToSinePeak(dbfs: number): number {
  return Math.pow(10, (dbfs + 20 * Math.log10(Math.SQRT2)) / 20);
}

function generateSine(length: number, sampleRate: number, frequency: number, peak: number): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < length; i++) {
    out[i] = peak * Math.sin(w * i);
  }
  return out;
}

function generateSparseClicks(length: number, interval: number, peak: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += interval) {
    out[i] = peak;
    if (i + 1 < length) out[i + 1] = peak * 0.5;
    if (i + 2 < length) out[i + 2] = peak * 0.25;
  }
  return out;
}

describe('input normalization analysis', () => {
  const sampleRate = 48_000;

  it('returns unity gain for a nominal -18 dBFS RMS sine', () => {
    const peak = dbfsRmsToSinePeak(-18);
    const signal = generateSine(sampleRate, sampleRate, 1_000, peak);

    const metrics = analyzeInputAlignment([signal], sampleRate);

    expect(metrics.programRmsDbfs).toBeCloseTo(-18, 1);
    expect(metrics.recommendedInputGain).toBeCloseTo(1, 2);
  });

  it('attenuates hot material toward the nominal machine level', () => {
    const peak = dbfsRmsToSinePeak(-9);
    const signal = generateSine(sampleRate, sampleRate, 1_000, peak);

    const metrics = analyzeInputAlignment([signal], sampleRate);

    expect(metrics.programRmsDbfs).toBeCloseTo(-9, 1);
    expect(metrics.recommendedInputGain).toBeLessThan(0.4);
    expect(metrics.recommendedInputGain).toBeGreaterThan(0.3);
  });

  it('ignores silence when estimating program level', () => {
    const peak = dbfsRmsToSinePeak(-18);
    const signal = new Float32Array(sampleRate * 2);
    signal.set(generateSine(sampleRate, sampleRate, 440, peak), sampleRate);

    const metrics = analyzeInputAlignment([signal], sampleRate);

    expect(metrics.activeWindowCount).toBeGreaterThan(0);
    expect(metrics.programRmsDbfs).toBeCloseTo(-18, 1);
    expect(metrics.recommendedInputGain).toBeCloseTo(1, 2);
  });

  it('caps boost at the allowed input gain range', () => {
    const peak = dbfsRmsToSinePeak(-36);
    const signal = generateSine(sampleRate, sampleRate, 1_000, peak);

    const metrics = analyzeInputAlignment([signal], sampleRate);

    expect(metrics.recommendedInputGain).toBeCloseTo(4, 6);
  });

  it('keeps drum mode more conservative for sparse transients', () => {
    const signal = generateSparseClicks(sampleRate * 2, sampleRate / 4, 0.95);

    const mixMetrics = analyzeInputAlignment([signal], sampleRate, 'mix');
    const drumMetrics = analyzeInputAlignment([signal], sampleRate, 'drums');

    expect(mixMetrics.activeWindowCount).toBeGreaterThan(0);
    expect(drumMetrics.activeWindowCount).toBeGreaterThan(0);
    expect(drumMetrics.recommendedInputGain).toBeLessThan(mixMetrics.recommendedInputGain);
    expect(drumMetrics.recommendedInputGain).toBeLessThanOrEqual(1);
  });
});
