import { describe, expect, it } from 'vitest';
import { WavelengthContour } from '../wavelength-contour';

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function measurePeak(
  processor: WavelengthContour,
  sampleRate: number,
  frequency: number,
  amplitude: number,
): number {
  let peak = 0;
  const totalSamples = sampleRate;
  const settleStart = sampleRate / 2;

  for (let i = 0; i < totalSamples; i++) {
    const x = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    const y = processor.process(x);
    if (i >= settleStart) {
      peak = Math.max(peak, Math.abs(y));
    }
  }

  return peak;
}

describe('WavelengthContour', () => {
  const sampleRate = 48_000;

  it('stays nearly transparent at nominal midband level', () => {
    const contour = new WavelengthContour(sampleRate, 15, 2e-6);
    contour.setDrive(0.35);
    contour.setSaturation(0.4);
    contour.setCoercivity(0.47);

    const gainDb = db(measurePeak(contour, sampleRate, 1_000, 0.08) / 0.08);
    expect(Math.abs(gainDb)).toBeLessThan(0.15);
  });

  it('loses more hot 10 kHz than hot 1 kHz', () => {
    const contourMid = new WavelengthContour(sampleRate, 15, 2e-6);
    contourMid.setDrive(0.45);
    contourMid.setSaturation(0.55);
    contourMid.setCoercivity(0.47);

    const contourHigh = new WavelengthContour(sampleRate, 15, 2e-6);
    contourHigh.setDrive(0.45);
    contourHigh.setSaturation(0.55);
    contourHigh.setCoercivity(0.47);

    const midGainDb = db(measurePeak(contourMid, sampleRate, 1_000, 0.55) / 0.55);
    const highGainDb = db(measurePeak(contourHigh, sampleRate, 10_000, 0.55) / 0.55);

    expect(highGainDb).toBeLessThan(midGainDb - 0.18);
  });

  it('compresses hot low frequencies more than hot mids', () => {
    const contourLow = new WavelengthContour(sampleRate, 15, 2e-6);
    contourLow.setDrive(0.45);
    contourLow.setSaturation(0.6);
    contourLow.setCoercivity(0.47);

    const contourMid = new WavelengthContour(sampleRate, 15, 2e-6);
    contourMid.setDrive(0.45);
    contourMid.setSaturation(0.6);
    contourMid.setCoercivity(0.47);

    const lowGainDb = db(measurePeak(contourLow, sampleRate, 60, 0.7) / 0.7);
    const midGainDb = db(measurePeak(contourMid, sampleRate, 1_000, 0.7) / 0.7);

    expect(lowGainDb).toBeLessThan(midGainDb - 0.2);
  });

  it('slower tape speed increases hot high-frequency loss', () => {
    const fast = new WavelengthContour(sampleRate, 15, 2e-6);
    fast.setDrive(0.45);
    fast.setSaturation(0.55);
    fast.setCoercivity(0.47);

    const slow = new WavelengthContour(sampleRate, 7.5, 2e-6);
    slow.setDrive(0.45);
    slow.setSaturation(0.55);
    slow.setCoercivity(0.47);

    const fastGainDb = db(measurePeak(fast, sampleRate, 10_000, 0.55) / 0.55);
    const slowGainDb = db(measurePeak(slow, sampleRate, 10_000, 0.55) / 0.55);

    expect(slowGainDb).toBeLessThan(fastGainDb - 0.15);
  });

  it('softer tape formulations lose more hot HF than higher-output tape', () => {
    const softTape = new WavelengthContour(sampleRate, 15, 2e-6);
    softTape.setDrive(0.45);
    softTape.setSaturation(0.55);
    softTape.setCoercivity(0.47);

    const strongTape = new WavelengthContour(sampleRate, 15, 2e-6);
    strongTape.setDrive(0.45);
    strongTape.setSaturation(0.55);
    strongTape.setCoercivity(0.55);

    const softGainDb = db(measurePeak(softTape, sampleRate, 10_000, 0.55) / 0.55);
    const strongGainDb = db(measurePeak(strongTape, sampleRate, 10_000, 0.55) / 0.55);

    expect(softGainDb).toBeLessThan(strongGainDb - 0.05);
  });
});
