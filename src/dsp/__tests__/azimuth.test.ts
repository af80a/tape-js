import { describe, expect, it } from 'vitest';
import { AzimuthModel } from '../azimuth';

describe('AzimuthModel', () => {
  const fs = 48_000;
  const speed15 = 15;
  const studerSpacing = 4.22e-3;
  const studerTrackWidth = 2.08e-3;
  const ampexTrackWidth = 5.33e-3;
  const arcminToRad = Math.PI / (180 * 60);

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

  function analyzeTone(
    model: AzimuthModel,
    frequency: number,
    length = 24_000,
    warmup = 4_096,
  ): { magnitude: number; phase: number } {
    let real = 0;
    let imag = 0;
    let count = 0;
    for (let i = 0; i < length; i++) {
      const x = Math.sin(2 * Math.PI * frequency * i / fs);
      const y = model.process(x);
      if (i >= warmup) {
        const angle = (2 * Math.PI * frequency * i) / fs;
        real += y * Math.cos(angle);
        imag -= y * Math.sin(angle);
        count++;
      }
    }
    return {
      magnitude: Math.hypot(real, imag) / Math.max(1, count),
      phase: Math.atan2(imag, real),
    };
  }

  function wrapPhase(angle: number): number {
    let wrapped = angle;
    while (wrapped > Math.PI) wrapped -= 2 * Math.PI;
    while (wrapped < -Math.PI) wrapped += 2 * Math.PI;
    return wrapped;
  }

  function normalizedSinc(x: number): number {
    if (Math.abs(x) < 1e-12) return 1;
    const pix = Math.PI * x;
    return Math.abs(Math.sin(pix) / pix);
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

  it('inter-channel phase shift follows the azimuth delay law across frequency', () => {
    const azimuthArcmin = 3;
    const azimuthDelaySec =
      studerSpacing * Math.tan(azimuthArcmin * arcminToRad) / (speed15 * 0.0254);

    for (const frequency of [500, 2_000, 8_000]) {
      const az0 = new AzimuthModel(fs, 0, speed15, studerSpacing, studerTrackWidth);
      const az1 = new AzimuthModel(fs, 1, speed15, studerSpacing, studerTrackWidth);
      az0.setAzimuth(azimuthArcmin);
      az1.setAzimuth(azimuthArcmin);
      az0.setWeave(0);
      az1.setWeave(0);

      const channel0 = analyzeTone(az0, frequency);
      const channel1 = analyzeTone(az1, frequency);
      const measuredPhaseDiff = wrapPhase(channel1.phase - channel0.phase);
      const expectedPhaseDiff = wrapPhase(-2 * Math.PI * frequency * azimuthDelaySec);
      const phaseError = wrapPhase(measuredPhaseDiff - expectedPhaseDiff);

      expect(Math.abs(phaseError)).toBeLessThan(0.12);
    }
  });

  it('per-track high-frequency loss tracks the theoretical sinc curve across frequency', () => {
    const azimuthArcmin = 30;
    const angleRad = azimuthArcmin * arcminToRad;

    for (const frequency of [1_000, 8_000, 16_000]) {
      const clean = new AzimuthModel(fs, 0, speed15, studerSpacing, ampexTrackWidth);
      const tilted = new AzimuthModel(fs, 0, speed15, studerSpacing, ampexTrackWidth);
      clean.setAzimuth(0);
      tilted.setAzimuth(azimuthArcmin);
      clean.setWeave(0);
      tilted.setWeave(0);

      const cleanTone = analyzeTone(clean, frequency);
      const tiltedTone = analyzeTone(tilted, frequency);
      const measuredGain = tiltedTone.magnitude / Math.max(cleanTone.magnitude, 1e-12);
      const theoreticalGain = normalizedSinc(
        ampexTrackWidth * frequency * Math.tan(angleRad) / (speed15 * 0.0254),
      );

      expect(Math.abs(measuredGain - theoreticalGain)).toBeLessThan(0.04);
    }
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
