import { describe, it, expect } from 'vitest';
import { AzimuthModel } from '../azimuth';

describe('AzimuthModel', () => {
  const fs = 48000;
  const speed15 = 15; // ips
  const trackSpacing = 4.22e-3; // Studer A810 1/4" 2-track (meters)

  it('channel 0 and channel 1 share the same base latency', () => {
    // Both channels go through the delay line. Channel 0 gets baseDelay
    // only; channel 1 gets baseDelay + azimuth offset. With azimuth=0,
    // both peaks should land at the same sample index.
    const az0 = new AzimuthModel(fs, 0, speed15, trackSpacing);
    const az1 = new AzimuthModel(fs, 1, speed15, trackSpacing);
    az0.setAzimuth(0);
    az1.setAzimuth(0);

    const N = 30;
    const out0: number[] = [];
    const out1: number[] = [];
    for (let i = 0; i < N; i++) {
      const x = i === 0 ? 1.0 : 0.0;
      out0.push(az0.process(x));
      out1.push(az1.process(x));
    }

    const peak0 = out0.indexOf(Math.max(...out0));
    const peak1 = out1.indexOf(Math.max(...out1));

    // At azimuth=0, drift floor is 0.1 arcmin → ~0.015 samples offset.
    // Both peaks should be within 1 sample of each other.
    expect(Math.abs(peak0 - peak1)).toBeLessThanOrEqual(1);
  });

  it('channel 1 introduces a delay proportional to azimuth angle', () => {
    const az = new AzimuthModel(fs, 1, speed15, trackSpacing);
    az.setAzimuth(3.0); // 3 arcminutes

    // Expected delay: d * tan(3') / v * fs
    // = 4.22e-3 * tan(3 * pi / (180*60)) / (15 * 0.0254) * 48000
    // = 4.22e-3 * 8.727e-4 / 0.381 * 48000 ≈ 0.464 samples
    // With baseDelay of 8, total delay ≈ 8.464 samples

    // Send an impulse and collect output
    const impulseResponse: number[] = [];
    impulseResponse.push(az.process(1.0));
    for (let i = 0; i < 20; i++) {
      impulseResponse.push(az.process(0.0));
    }

    // The impulse should appear delayed — not at sample 0.
    // With baseDelay=8, peak should be around sample 8-9.
    const peakIdx = impulseResponse.indexOf(Math.max(...impulseResponse));
    expect(peakIdx).toBeGreaterThanOrEqual(7);
    expect(peakIdx).toBeLessThanOrEqual(10);
  });

  it('larger azimuth angle produces more delay', () => {
    // Measure group delay via cross-correlation of a chirp signal
    function measureDelay(arcmin: number): number {
      const az = new AzimuthModel(fs, 1, speed15, trackSpacing);
      az.setAzimuth(arcmin);

      // Generate a sine burst and measure the peak position
      const N = 200;
      const out: number[] = [];
      for (let i = 0; i < N; i++) {
        const x = i < 50 ? Math.sin(2 * Math.PI * 1000 * i / fs) : 0;
        out.push(az.process(x));
      }

      // Find peak absolute value position
      let maxVal = 0, maxIdx = 0;
      for (let i = 0; i < N; i++) {
        if (Math.abs(out[i]) > maxVal) {
          maxVal = Math.abs(out[i]);
          maxIdx = i;
        }
      }
      return maxIdx;
    }

    const delay1 = measureDelay(1.0);
    const delay3 = measureDelay(3.0);
    const delay6 = measureDelay(6.0);

    // More azimuth → more delay (peak appears later)
    expect(delay3).toBeGreaterThanOrEqual(delay1);
    expect(delay6).toBeGreaterThan(delay3);
  });

  it('lower tape speed increases delay (same angle, longer wavelength)', () => {
    function measurePeakDelay(speedIps: number): number {
      const az = new AzimuthModel(fs, 1, speedIps, trackSpacing);
      az.setAzimuth(3.0);

      const N = 200;
      const out: number[] = [];
      for (let i = 0; i < N; i++) {
        out.push(az.process(i === 0 ? 1.0 : 0.0));
      }

      let maxVal = 0, maxIdx = 0;
      for (let i = 0; i < N; i++) {
        if (Math.abs(out[i]) > maxVal) {
          maxVal = Math.abs(out[i]);
          maxIdx = i;
        }
      }
      return maxIdx;
    }

    const delayFast = measurePeakDelay(30);
    const delaySlow = measurePeakDelay(7.5);

    // Slower speed → more delay (delay ∝ 1/v)
    expect(delaySlow).toBeGreaterThan(delayFast);
  });

  it('wider track spacing increases delay', () => {
    function measurePeakDelay(spacing: number): number {
      const az = new AzimuthModel(fs, 1, speed15, spacing);
      az.setAzimuth(3.0);

      const N = 200;
      const out: number[] = [];
      for (let i = 0; i < N; i++) {
        out.push(az.process(i === 0 ? 1.0 : 0.0));
      }

      let maxVal = 0, maxIdx = 0;
      for (let i = 0; i < N; i++) {
        if (Math.abs(out[i]) > maxVal) {
          maxVal = Math.abs(out[i]);
          maxIdx = i;
        }
      }
      return maxIdx;
    }

    const delayNarrow = measurePeakDelay(2.13e-3); // MCI JH-24
    const delayWide = measurePeakDelay(6.86e-3);   // Ampex ATR-102

    expect(delayWide).toBeGreaterThanOrEqual(delayNarrow);
  });

  it('drift modulates the delay over time', () => {
    const az = new AzimuthModel(fs, 1, speed15, trackSpacing);
    az.setAzimuth(3.0);

    // Collect output at different time offsets by sending
    // impulses spaced far apart (beyond buffer clearing)
    const N = 48000; // 1 second
    const delays: number[] = [];

    // Run for a while, then measure the output phase of a reference tone
    // at different time points to detect drift modulation.
    // Simpler approach: measure the instantaneous output amplitude variation
    // of a constant-amplitude sine wave over time.
    const freq = 5000; // High enough that phase shifts are audible
    const blockSize = 4800; // 100ms blocks
    const numBlocks = 10;

    for (let b = 0; b < numBlocks; b++) {
      let peakInBlock = 0;
      for (let i = 0; i < blockSize; i++) {
        const t = b * blockSize + i;
        const x = Math.sin(2 * Math.PI * freq * t / fs);
        const y = az.process(x);
        peakInBlock = Math.max(peakInBlock, Math.abs(y));
      }
      delays.push(peakInBlock);
    }

    // The output should not be perfectly constant due to drift
    // modulating the fractional delay (which slightly changes
    // the interpolation and thus amplitude). This is a weak test
    // but confirms drift is active.
    const allSame = delays.every((d) => d === delays[0]);
    expect(allSame).toBe(false);
  });

  it('zero azimuth produces minimal delay on channel 1', () => {
    const az = new AzimuthModel(fs, 1, speed15, trackSpacing);
    az.setAzimuth(0.0);

    // With azimuth=0, static angle is 0. Drift floor is 0.1 arcmin.
    // Delay should be very small (< 0.05 samples beyond base).
    // Send impulse and check peak is near the base delay.
    const N = 30;
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      out.push(az.process(i === 0 ? 1.0 : 0.0));
    }

    const peakIdx = out.indexOf(Math.max(...out));
    // Base delay is 8. With ~0 azimuth, peak should be at exactly 8.
    expect(peakIdx).toBeGreaterThanOrEqual(7);
    expect(peakIdx).toBeLessThanOrEqual(9);
  });

  it('reset clears buffer and drift state', () => {
    const az = new AzimuthModel(fs, 1, speed15, trackSpacing);
    az.setAzimuth(3.0);

    // Process some signal
    for (let i = 0; i < 100; i++) {
      az.process(Math.sin(2 * Math.PI * 1000 * i / fs));
    }

    // Reset and verify output is silent
    az.reset();
    const postReset = az.process(0.0);
    expect(postReset).toBe(0);
  });

  it('output is always finite under normal conditions', () => {
    const az = new AzimuthModel(fs, 1, speed15, trackSpacing);
    az.setAzimuth(6.0); // max realistic

    for (let i = 0; i < 10000; i++) {
      const x = Math.sin(2 * Math.PI * 440 * i / fs);
      const y = az.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});
