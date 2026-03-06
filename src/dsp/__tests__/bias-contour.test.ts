import { describe, expect, it } from 'vitest';
import { BiasContour } from '../bias-contour';

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function measurePeak(processor: BiasContour, sampleRate: number, frequency: number): number {
  let peak = 0;
  const totalSamples = sampleRate;
  const settleStart = sampleRate / 2;

  for (let i = 0; i < totalSamples; i++) {
    const x = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    const y = processor.process(x);
    if (i >= settleStart) {
      peak = Math.max(peak, Math.abs(y));
    }
  }

  return peak;
}

describe('BiasContour', () => {
  const sampleRate = 48_000;
  const nominalBias = 0.75;
  const nominalPeak = 0.5;

  it('is effectively transparent at the aligned bias point', () => {
    const nominal = new BiasContour(sampleRate, 15, nominalBias);
    nominal.setBias(nominalBias);

    const gain1kDb = db(measurePeak(nominal, sampleRate, 1_000) / nominalPeak);
    const gain10kDb = db(measurePeak(nominal, sampleRate, 10_000) / nominalPeak);

    expect(Math.abs(gain1kDb)).toBeLessThan(0.1);
    expect(Math.abs(gain10kDb)).toBeLessThan(0.15);
  });

  it('overbias attenuates HF more than underbias', () => {
    const under = new BiasContour(sampleRate, 15, nominalBias);
    under.setBias(0.35);
    const over = new BiasContour(sampleRate, 15, nominalBias);
    over.setBias(1.0);

    const under10k = measurePeak(under, sampleRate, 10_000);
    const over10k = measurePeak(over, sampleRate, 10_000);

    expect(over10k).toBeLessThan(under10k * 0.97);
  });

  it('bias contour is more audible in the highs than the mids', () => {
    const underMid = new BiasContour(sampleRate, 15, nominalBias);
    underMid.setBias(0.35);
    const overMid = new BiasContour(sampleRate, 15, nominalBias);
    overMid.setBias(1.0);
    const underHigh = new BiasContour(sampleRate, 15, nominalBias);
    underHigh.setBias(0.35);
    const overHigh = new BiasContour(sampleRate, 15, nominalBias);
    overHigh.setBias(1.0);

    const midDeltaDb = Math.abs(db(measurePeak(overMid, sampleRate, 1_000) / measurePeak(underMid, sampleRate, 1_000)));
    const highDeltaDb = Math.abs(db(measurePeak(overHigh, sampleRate, 10_000) / measurePeak(underHigh, sampleRate, 10_000)));

    expect(highDeltaDb).toBeGreaterThan(midDeltaDb + 0.2);
  });

  it('extreme overbias stays within a realistic high-frequency loss range', () => {
    const nominal = new BiasContour(sampleRate, 15, nominalBias);
    nominal.setBias(nominalBias);
    const over = new BiasContour(sampleRate, 15, nominalBias);
    over.setBias(1.0);

    const lossDb = db(measurePeak(over, sampleRate, 10_000) / measurePeak(nominal, sampleRate, 10_000));

    expect(lossDb).toBeLessThan(-0.2);
    expect(lossDb).toBeGreaterThan(-2.5);
  });

  it('slower tape speed increases overbias HF loss', () => {
    const fast = new BiasContour(sampleRate, 15, nominalBias);
    fast.setBias(1.0);
    const slow = new BiasContour(sampleRate, 7.5, nominalBias);
    slow.setBias(1.0);

    const fastRatio = measurePeak(fast, sampleRate, 10_000) / measurePeak(new BiasContour(sampleRate, 15, nominalBias), sampleRate, 1_000);
    const slowRatio = measurePeak(slow, sampleRate, 10_000) / measurePeak(new BiasContour(sampleRate, 7.5, nominalBias), sampleRate, 1_000);

    expect(slowRatio).toBeLessThan(fastRatio);
  });
});
