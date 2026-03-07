import { describe, it, expect } from 'vitest';
import { TapeNoise } from '../noise';

describe('TapeNoise', () => {
  const fs = 44100;

  it('produces shaped noise with nonzero output', () => {
    const noise = new TapeNoise(fs);
    noise.setLevel(0.5);

    let maxOut = 0;
    for (let i = 0; i < 1000; i++) {
      const y = noise.process();
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeGreaterThan(0);
  });

  it('returns 0 when level is near zero', () => {
    const noise = new TapeNoise(fs);
    noise.setLevel(0);

    for (let i = 0; i < 100; i++) {
      expect(noise.process()).toBe(0);
    }
  });

  describe('stable hiss floor', () => {
    it('process accepts an optional signalLevel parameter', () => {
      const noise = new TapeNoise(fs);
      noise.setLevel(0.5);

      // Should not throw
      const y = noise.process(0.8);
      expect(Number.isFinite(y)).toBe(true);
    });

    it('noise RMS stays broadly consistent with loud signal and silence', () => {
      const noiseLoud = new TapeNoise(fs);
      const noiseSilent = new TapeNoise(fs);
      noiseLoud.setLevel(0.5);
      noiseSilent.setLevel(0.5);

      const numSamples = 20000;
      let sumSqLoud = 0;
      let sumSqSilent = 0;

      for (let i = 0; i < numSamples; i++) {
        const sig = 0.9 * Math.sin(2 * Math.PI * 400 * i / fs);
        const yLoud = noiseLoud.process(sig);
        const ySilent = noiseSilent.process(0);
        sumSqLoud += yLoud * yLoud;
        sumSqSilent += ySilent * ySilent;
      }

      const rmsLoud = Math.sqrt(sumSqLoud / numSamples);
      const rmsSilent = Math.sqrt(sumSqSilent / numSamples);

      const ratio = rmsLoud / rmsSilent;
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    });

    it('noise floor does not scale materially with signal level', () => {
      const noiseHalf = new TapeNoise(fs);
      const noiseFull = new TapeNoise(fs);
      noiseHalf.setLevel(0.5);
      noiseFull.setLevel(0.5);

      const numSamples = 40000;
      let sumSqHalf = 0;
      let sumSqFull = 0;

      for (let i = 0; i < numSamples; i++) {
        const sigHalf = 0.5 * Math.sin(2 * Math.PI * 400 * i / fs);
        const sigFull = 1.0 * Math.sin(2 * Math.PI * 400 * i / fs);
        const yHalf = noiseHalf.process(sigHalf);
        const yFull = noiseFull.process(sigFull);
        sumSqHalf += yHalf * yHalf;
        sumSqFull += yFull * yFull;
      }

      const rmsHalf = Math.sqrt(sumSqHalf / numSamples);
      const rmsFull = Math.sqrt(sumSqFull / numSamples);

      const ratio = rmsFull / rmsHalf;
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    });

    it('backward compatible: process() without argument matches original behavior', () => {
      const noise = new TapeNoise(fs);
      noise.setLevel(0.5);

      // process() with no signal should still produce noise (the bias/hiss component)
      let maxOut = 0;
      for (let i = 0; i < 1000; i++) {
        const y = noise.process();
        maxOut = Math.max(maxOut, Math.abs(y));
      }

      expect(maxOut).toBeGreaterThan(0);
    });
  });
});
