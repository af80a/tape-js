import { describe, it, expect } from 'vitest';
import { HeadModel } from '../head-model';

/**
 * Evidence notes:
 * - Gap loss follows sinc(pi * g * f / v) from finite playback-gap averaging.
 * - Spacing loss follows the Wallace equation exp(-2 * pi * d * f / v).
 * - These tests prefer analytical comparisons or monotonic geometry changes over
 *   snapshots of the current implementation.
 */

describe('HeadModel', () => {
  const fs = 44100;
  const tapeSpeed = 15; // ips

  // No Math.random mock needed: HeadModel uses per-instance xorshift32 PRNG,
  // and dropoutIntensity defaults to 0 (no random calls unless explicitly enabled).

  /**
   * Helper: measure steady-state peak amplitude of a sine wave
   * processed through the head model.
   */
  function measurePeak(model: HeadModel, freq: number): number {
    const duration = 4000; // samples
    const settleTime = 2000; // samples to skip for transient (FIR needs more settling)

    let maxOutput = 0;
    for (let i = 0; i < duration; i++) {
      const x = Math.sin((2 * Math.PI * freq * i) / fs);
      const y = model.process(x);
      if (i >= settleTime) {
        maxOutput = Math.max(maxOutput, Math.abs(y));
      }
    }
    return maxOutput;
  }

  it('head bump boosts LF: 55Hz output >= 90% of 1kHz output', () => {
    const model = new HeadModel(fs, tapeSpeed);
    const peak55 = measurePeak(model, 55);
    model.reset();
    const peak1k = measurePeak(model, 1000);

    expect(peak55).toBeGreaterThanOrEqual(peak1k * 0.9);
  });

  it('gap loss rolls off HF: 15kHz output < 1kHz output', () => {
    const model = new HeadModel(fs, tapeSpeed);
    const peak15k = measurePeak(model, 15000);
    model.reset();
    const peak1k = measurePeak(model, 1000);

    expect(peak15k).toBeLessThan(peak1k);
  });

  it('bumpGainDb option controls head bump magnitude', () => {
    // Small bump (like MCI: 2.0 dB)
    const smallBump = new HeadModel(fs, tapeSpeed, { bumpGainDb: 2.0 });
    const smallPeak = measurePeak(smallBump, 55);
    smallBump.reset();
    const smallRef = measurePeak(smallBump, 1000);

    // Large bump (like Ampex: 3.5 dB)
    const largeBump = new HeadModel(fs, tapeSpeed, { bumpGainDb: 3.5 });
    const largePeak = measurePeak(largeBump, 55);
    largeBump.reset();
    const largeRef = measurePeak(largeBump, 1000);

    // Larger bumpGainDb should produce more LF boost relative to 1 kHz
    const smallRatio = smallPeak / smallRef;
    const largeRatio = largePeak / largeRef;
    expect(largeRatio).toBeGreaterThan(smallRatio);
  });

  it('head bump Q varies with tape speed (broader at lower speeds)', () => {
    // At different tape speeds, the bump should have different Q (width).
    // Lower speed → broader bump (lower Q), higher speed → narrower bump (higher Q).
    // We test this by measuring the normalized selectivity: peak(f0) / peak(f0 * 1.25).
    // With speed-dependent Q, these ratios should differ between speeds.

    function measureSelectivity(speed: number): number {
      const bumpFreq = speed * 3.67;
      const model = new HeadModel(fs, speed, { gapWidth: 0, spacing: 0 });
      const peakOn = measurePeak(model, bumpFreq);
      model.reset();
      const peakOff = measurePeak(model, bumpFreq * 1.25);
      return peakOn / peakOff;
    }

    const sel7 = measureSelectivity(7.5);
    const sel30 = measureSelectivity(30);

    // With speed-dependent Q, selectivity should increase noticeably with speed.
    expect(sel30 - sel7).toBeGreaterThan(0.10);
  });

  it('head bump dip attenuates at 2x bump frequency', () => {
    // The dip filter should create a notch at 2 * bumpFreq.
    // Compare output at bump freq vs 2x bump freq with no gap/spacing loss.
    const bumpFreq = tapeSpeed * 3.67;
    const model = new HeadModel(fs, tapeSpeed, { gapWidth: 0, spacing: 0 });
    const peakAtBump = measurePeak(model, bumpFreq);
    model.reset();
    const peakAtDip = measurePeak(model, bumpFreq * 2);

    // The bump should be louder than the dip region
    expect(peakAtBump).toBeGreaterThan(peakAtDip * 1.3);
  });

  describe('FIR loss filter (sinc gap loss + spacing loss)', () => {
    it('constructor accepts gapWidth and spacing parameters', () => {
      const model = new HeadModel(fs, tapeSpeed, {
        gapWidth: 2e-6,
        spacing: 0.5e-6,
      });
      expect(model).toBeDefined();
    });

    it('smaller gap width produces less HF loss', () => {
      // Narrow gap: less HF rolloff
      const narrow = new HeadModel(fs, tapeSpeed, { gapWidth: 1e-6, spacing: 0 });
      const narrowPeak = measurePeak(narrow, 15000);
      narrow.reset();
      const narrowRef = measurePeak(narrow, 1000);

      // Wide gap: more HF rolloff
      const wide = new HeadModel(fs, tapeSpeed, { gapWidth: 5e-6, spacing: 0 });
      const widePeak = measurePeak(wide, 15000);
      wide.reset();
      const wideRef = measurePeak(wide, 1000);

      // Both should attenuate HF relative to 1kHz, but wide gap more so
      const narrowRatio = narrowPeak / narrowRef;
      const wideRatio = widePeak / wideRef;
      expect(wideRatio).toBeLessThan(narrowRatio);
    });

    it('spacing loss adds additional HF attenuation', () => {
      // No spacing
      const noSpace = new HeadModel(fs, tapeSpeed, { gapWidth: 2e-6, spacing: 0 });
      const noSpacePeak = measurePeak(noSpace, 15000);
      noSpace.reset();
      const noSpaceRef = measurePeak(noSpace, 1000);

      // With spacing
      const withSpace = new HeadModel(fs, tapeSpeed, { gapWidth: 2e-6, spacing: 5e-6 });
      const withSpacePeak = measurePeak(withSpace, 15000);
      withSpace.reset();
      const withSpaceRef = measurePeak(withSpace, 1000);

      const noSpaceRatio = noSpacePeak / noSpaceRef;
      const withSpaceRatio = withSpacePeak / withSpaceRef;

      // Spacing should add more HF loss
      expect(withSpaceRatio).toBeLessThan(noSpaceRatio);
    });

    it('spacing-only loss follows the Wallace exponential at high frequency', () => {
      const frequency = 10_000;
      const spacing = 5e-6;
      const clean = new HeadModel(fs, tapeSpeed, { gapWidth: 0, spacing: 0, bumpGainDb: 0 });
      const spaced = new HeadModel(fs, tapeSpeed, { gapWidth: 0, spacing, bumpGainDb: 0 });

      const cleanPeak = measurePeak(clean, frequency);
      const spacedPeak = measurePeak(spaced, frequency);
      const measuredGain = spacedPeak / Math.max(cleanPeak, 1e-12);
      const tapeSpeedMps = tapeSpeed * 0.0254;
      const theoreticalGain = Math.exp((-2 * Math.PI * spacing * frequency) / tapeSpeedMps);

      expect(Math.abs(measuredGain - theoreticalGain)).toBeLessThan(0.05);
    });

    it('lower tape speed increases HF loss (shorter wavelength at same frequency)', () => {
      const fast = new HeadModel(fs, 15, { gapWidth: 3e-6, spacing: 0, bumpGainDb: 0 });
      const fastPeak = measurePeak(fast, 12000);
      fast.reset();
      const fastRef = measurePeak(fast, 500);

      const slow = new HeadModel(fs, 7.5, { gapWidth: 3e-6, spacing: 0, bumpGainDb: 0 });
      const slowPeak = measurePeak(slow, 12000);
      slow.reset();
      const slowRef = measurePeak(slow, 500);

      const fastRatio = fastPeak / fastRef;
      const slowRatio = slowPeak / slowRef;

      // Slower speed = shorter wavelength at same freq = more gap loss
      expect(slowRatio).toBeLessThan(fastRatio);
    });

    it('produces no NaN for 1 second of audio', () => {
      const model = new HeadModel(fs, tapeSpeed, { gapWidth: 2e-6, spacing: 1e-6 });
      for (let i = 0; i < fs; i++) {
        const y = model.process(Math.sin(2 * Math.PI * 440 * i / fs));
        expect(Number.isFinite(y)).toBe(true);
      }
    });
  });

  describe('stochastic dropouts', () => {
    it('dropout with high intensity causes HF loss over many samples', () => {
      // HeadModel uses per-instance xorshift32 PRNG (not Math.random),
      // so we can't mock the random source. Instead, run for long enough
      // that at least one dropout statistically occurs (at max intensity,
      // probability per sample = 5e-6 → expected ~1 dropout per 200k samples,
      // so 500k samples should reliably trigger several).
      const clean = new HeadModel(fs, tapeSpeed, { gapWidth: 0, spacing: 0, bumpGainDb: 0 });
      const dirty = new HeadModel(fs, tapeSpeed, { gapWidth: 0, spacing: 0, bumpGainDb: 0 }, 42);
      dirty.setDropoutIntensity(1.0);

      const freq = 10000;
      const totalSamples = 500000;
      let cleanEnergy = 0, dirtyEnergy = 0;

      for (let i = 0; i < totalSamples; i++) {
        const x = Math.sin(2 * Math.PI * freq * i / fs);
        const yClean = clean.process(x);
        const yDirty = dirty.process(x);

        cleanEnergy += yClean * yClean;
        dirtyEnergy += yDirty * yDirty;
      }

      // Dropouts cause momentary HF attenuation, reducing total energy.
      // With several dropouts over 500k samples, dirty energy should be
      // measurably less than clean energy.
      expect(dirtyEnergy).toBeLessThan(cleanEnergy);
    });
  });
});
