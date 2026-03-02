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

  describe('signal-dependent modulation noise', () => {
    it('process accepts an optional signalLevel parameter', () => {
      const noise = new TapeNoise(fs);
      noise.setLevel(0.5);

      // Should not throw
      const y = noise.process(0.8);
      expect(Number.isFinite(y)).toBe(true);
    });

    it('noise RMS is higher with loud signal than with silence', () => {
      // Modulation noise scales with signal envelope: louder signal = more noise.
      // This is the signature "breathing" quality of tape.
      const noiseLoud = new TapeNoise(fs);
      const noiseSilent = new TapeNoise(fs);
      noiseLoud.setLevel(0.5);
      noiseSilent.setLevel(0.5);

      const numSamples = 20000;
      let sumSqLoud = 0;
      let sumSqSilent = 0;

      for (let i = 0; i < numSamples; i++) {
        const yLoud = noiseLoud.process(0.9);  // loud signal
        const ySilent = noiseSilent.process(0); // silence
        sumSqLoud += yLoud * yLoud;
        sumSqSilent += ySilent * ySilent;
      }

      const rmsLoud = Math.sqrt(sumSqLoud / numSamples);
      const rmsSilent = Math.sqrt(sumSqSilent / numSamples);

      // With modulation noise, loud signal should produce measurably more noise
      expect(rmsLoud).toBeGreaterThan(rmsSilent * 1.2);
    });

    it('modulation noise scales proportionally with signal level', () => {
      // Modulation noise at signalLevel=0.5 should be roughly half of signalLevel=1.0
      const noiseHalf = new TapeNoise(fs);
      const noiseFull = new TapeNoise(fs);
      noiseHalf.setLevel(0.5);
      noiseFull.setLevel(0.5);

      const numSamples = 40000;
      let sumSqHalf = 0;
      let sumSqFull = 0;

      for (let i = 0; i < numSamples; i++) {
        const yHalf = noiseHalf.process(0.5);
        const yFull = noiseFull.process(1.0);
        sumSqHalf += yHalf * yHalf;
        sumSqFull += yFull * yFull;
      }

      const rmsHalf = Math.sqrt(sumSqHalf / numSamples);
      const rmsFull = Math.sqrt(sumSqFull / numSamples);

      // Modulation component: rmsHalf should be less than rmsFull
      // but both include the fixed bias noise floor, so ratio won't be exactly 2:1
      // Check that louder signal produces more noise
      expect(rmsFull).toBeGreaterThan(rmsHalf);
      // And the ratio should be between 1.1x and 3x (not exactly proportional due to bias noise)
      const ratio = rmsFull / rmsHalf;
      expect(ratio).toBeGreaterThan(1.1);
      expect(ratio).toBeLessThan(3.0);
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
