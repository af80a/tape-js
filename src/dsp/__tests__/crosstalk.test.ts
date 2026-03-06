import { describe, expect, it } from 'vitest';
import { CrosstalkModel } from '../crosstalk';

const FS = 48_000;

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function generateSine(length: number, frequency: number): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * frequency) / FS;
  for (let i = 0; i < length; i++) {
    out[i] = Math.sin(w * i);
  }
  return out;
}

function goertzelMagnitude(
  signal: Float32Array,
  frequency: number,
  start = 0,
  end = signal.length,
): number {
  const w = (2 * Math.PI * frequency) / FS;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;

  for (let i = start; i < end; i++) {
    const s0 = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / Math.max(1, end - start);
}

function measureBleedDb(amount: number, frequency: number): number {
  const model = new CrosstalkModel(FS, 2);
  model.setAmount(amount);

  const totalLength = 24_000;
  const warmup = 4_096;
  const left = generateSine(totalLength, frequency);
  const right = new Float32Array(totalLength);
  model.process([left, right]);

  const source = goertzelMagnitude(left, frequency, warmup, totalLength);
  const bleed = goertzelMagnitude(right, frequency, warmup, totalLength);
  return db(bleed / Math.max(source, 1e-12));
}

describe('CrosstalkModel', () => {
  it('scales the 1 kHz bleed level with the documented amount calibration', () => {
    const atrDb = measureBleedDb(0.006, 1_000);
    const studerStereoDb = measureBleedDb(0.0018, 1_000);
    const studerTwoTrackDb = measureBleedDb(0.0006, 1_000);

    expect(atrDb).toBeGreaterThan(-46.5);
    expect(atrDb).toBeLessThan(-43.5);
    expect(atrDb - studerStereoDb).toBeGreaterThan(8);
    expect(atrDb - studerStereoDb).toBeLessThan(12);
    expect(studerStereoDb - studerTwoTrackDb).toBeGreaterThan(8);
    expect(studerStereoDb - studerTwoTrackDb).toBeLessThan(12);
  });

  it('shows the expected bathtub-shaped frequency dependence', () => {
    const lowDb = measureBleedDb(0.006, 100);
    const lowerMidDb = measureBleedDb(0.006, 1_000);
    const upperMidDb = measureBleedDb(0.006, 3_000);
    const highDb = measureBleedDb(0.006, 10_000);
    const bestMidDb = Math.min(lowerMidDb, upperMidDb);

    // More-negative dB means better separation.
    expect(bestMidDb).toBeLessThan(lowDb - 3);
    expect(bestMidDb).toBeLessThan(highDb - 1);
    expect(lowDb).toBeGreaterThan(lowerMidDb + 2);
  });
});
