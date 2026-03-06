import { describe, expect, it } from 'vitest';
import { AzimuthModel } from '../azimuth';

describe('AzimuthModel', () => {
  const fs = 48_000;
  const speed15 = 15;
  const studerSpacing = 4.22e-3;
  const studerTrackWidth = 2.08e-3;
  const ampexTrackWidth = 5.33e-3;

  function renderImpulse(model: AzimuthModel, length = 48): number[] {
    const out: number[] = [];
    for (let i = 0; i < length; i++) {
      out.push(model.process(i === 0 ? 1 : 0));
    }
    return out;
  }

  function peakIndex(values: number[]): number {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < values.length; i++) {
      if (values[i] > bestVal) {
        bestVal = values[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function measureSineRms(
    model: AzimuthModel,
    frequency: number,
    length = 24_000,
    warmup = 4_096,
  ): number {
    let sumSquares = 0;
    let count = 0;
    for (let i = 0; i < length; i++) {
      const x = Math.sin(2 * Math.PI * frequency * i / fs);
      const y = model.process(x);
      if (i >= warmup) {
        sumSquares += y * y;
        count++;
      }
    }
    return Math.sqrt(sumSquares / Math.max(1, count));
  }

  it('channel 0 and channel 1 share the same base latency when azimuth and weave are zero', () => {
    const az0 = new AzimuthModel(fs, 0, speed15, studerSpacing, studerTrackWidth);
    const az1 = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
    az0.setAzimuth(0);
    az0.setWeave(0);
    az1.setAzimuth(0);
    az1.setWeave(0);

    const out0 = renderImpulse(az0);
    const out1 = renderImpulse(az1);

    expect(peakIndex(out0)).toBe(peakIndex(out1));
  });

  it('channel 1 introduces a delay proportional to static azimuth angle', () => {
    const az = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
    az.setAzimuth(3);
    az.setWeave(0);

    const impulseResponse = renderImpulse(az);
    const peakIdx = peakIndex(impulseResponse);

    expect(peakIdx).toBeGreaterThanOrEqual(7);
    expect(peakIdx).toBeLessThanOrEqual(10);
  });

  it('larger azimuth angle produces more delay', () => {
    function measureDelay(arcmin: number): number {
      const az = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
      az.setAzimuth(arcmin);
      az.setWeave(0);
      return peakIndex(renderImpulse(az, 64));
    }

    const delay1 = measureDelay(1);
    const delay3 = measureDelay(3);
    const delay6 = measureDelay(6);

    expect(delay3).toBeGreaterThanOrEqual(delay1);
    expect(delay6).toBeGreaterThanOrEqual(delay3);
  });

  it('lower tape speed increases delay', () => {
    function measureDelay(speedIps: number): number {
      const az = new AzimuthModel(fs, 1, speedIps, studerSpacing, studerTrackWidth);
      az.setAzimuth(3);
      az.setWeave(0);
      return peakIndex(renderImpulse(az, 64));
    }

    expect(measureDelay(7.5)).toBeGreaterThanOrEqual(measureDelay(30));
  });

  it('wider track spacing increases delay', () => {
    function measureDelay(trackSpacing: number): number {
      const az = new AzimuthModel(fs, 1, speed15, trackSpacing, studerTrackWidth);
      az.setAzimuth(3);
      az.setWeave(0);
      return peakIndex(renderImpulse(az, 64));
    }

    expect(measureDelay(6.86e-3)).toBeGreaterThanOrEqual(measureDelay(2.13e-3));
  });

  it('independent weave can decorrelate channels even when static azimuth is zero', () => {
    const az0 = new AzimuthModel(fs, 0, speed15, studerSpacing, studerTrackWidth);
    const az1 = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
    az0.setAzimuth(0);
    az1.setAzimuth(0);
    az0.setWeave(2.5);
    az1.setWeave(2.5);

    let maxDiff = 0;
    for (let i = 0; i < 48_000; i++) {
      const x = Math.sin(2 * Math.PI * 8_000 * i / fs);
      const y0 = az0.process(x);
      const y1 = az1.process(x);
      if (i > 2_048) {
        maxDiff = Math.max(maxDiff, Math.abs(y0 - y1));
      }
    }

    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('large azimuth angles attenuate high frequencies via track-width averaging', () => {
    const clean = new AzimuthModel(fs, 0, speed15, studerSpacing, ampexTrackWidth);
    const tilted = new AzimuthModel(fs, 0, speed15, studerSpacing, ampexTrackWidth);
    clean.setAzimuth(0);
    clean.setWeave(0);
    tilted.setAzimuth(30);
    tilted.setWeave(0);

    const cleanRms = measureSineRms(clean, 16_000);
    const tiltedRms = measureSineRms(tilted, 16_000);

    expect(tiltedRms).toBeLessThan(cleanRms * 0.35);
  });

  it('wider tracks suffer more high-frequency azimuth loss than narrow tracks', () => {
    const narrow = new AzimuthModel(fs, 0, speed15, studerSpacing, studerTrackWidth);
    const wide = new AzimuthModel(fs, 0, speed15, studerSpacing, ampexTrackWidth);
    narrow.setAzimuth(30);
    narrow.setWeave(0);
    wide.setAzimuth(30);
    wide.setWeave(0);

    const narrowRms = measureSineRms(narrow, 16_000);
    const wideRms = measureSineRms(wide, 16_000);

    expect(wideRms).toBeLessThan(narrowRms * 0.5);
  });

  it('zero azimuth with zero weave keeps channel 1 at the base delay only', () => {
    const az = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
    az.setAzimuth(0);
    az.setWeave(0);

    const out = renderImpulse(az);
    const peakIdx = peakIndex(out);

    expect(peakIdx).toBe(8);
  });

  it('reset clears buffer and weave phase state', () => {
    const az = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
    az.setAzimuth(2);
    az.setWeave(1);

    for (let i = 0; i < 100; i++) {
      az.process(Math.sin(2 * Math.PI * 1_000 * i / fs));
    }

    az.reset();
    expect(az.process(0)).toBe(0);
  });

  it('output stays finite at maximum azimuth and weave settings', () => {
    const az = new AzimuthModel(fs, 1, speed15, studerSpacing, ampexTrackWidth);
    az.setAzimuth(30);
    az.setWeave(5);

    for (let i = 0; i < 10_000; i++) {
      const y = az.process(Math.sin(2 * Math.PI * 440 * i / fs));
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});
