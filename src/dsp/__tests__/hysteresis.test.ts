import { describe, it, expect } from 'vitest';
import { HysteresisProcessor } from '../hysteresis';

describe('HysteresisProcessor', () => {
  const sampleRate = 44100;

  it('zero input produces zero output', () => {
    const hp = new HysteresisProcessor(sampleRate);

    // Process several zero samples
    for (let i = 0; i < 100; i++) {
      const out = hp.process(0);
      expect(out).toBe(0);
    }
  });

  it('non-zero input produces non-zero output (440Hz sine)', () => {
    const hp = new HysteresisProcessor(sampleRate);
    hp.setDrive(0.5);

    const freq = 440;
    let maxOut = 0;

    for (let i = 0; i < sampleRate; i++) {
      const x = Math.sin(2 * Math.PI * freq * i / sampleRate);
      const y = hp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeGreaterThan(0);
  });

  it('saturates: large input does not produce proportionally large output', () => {
    const hp = new HysteresisProcessor(sampleRate);
    hp.setDrive(0.8);
    hp.setSaturation(0.5);

    const freq = 440;

    // First, measure output for unit-amplitude input
    let maxOutUnit = 0;
    for (let i = 0; i < sampleRate; i++) {
      const x = Math.sin(2 * Math.PI * freq * i / sampleRate);
      const y = hp.process(x);
      maxOutUnit = Math.max(maxOutUnit, Math.abs(y));
    }

    hp.reset();

    // Now measure output for 5x amplitude input
    let maxOut5x = 0;
    for (let i = 0; i < sampleRate; i++) {
      const x = 5.0 * Math.sin(2 * Math.PI * freq * i / sampleRate);
      const y = hp.process(x);
      maxOut5x = Math.max(maxOut5x, Math.abs(y));
    }

    // Both outputs should be non-zero
    expect(maxOutUnit).toBeGreaterThan(0);
    expect(maxOut5x).toBeGreaterThan(0);

    // The ratio should be much less than 5.0 due to saturation
    // A linear system would give ratio = 5.0; saturation compresses this
    const ratio = maxOut5x / maxOutUnit;
    expect(ratio).toBeLessThan(3.0);
    expect(maxOut5x).toBeLessThan(2.0);
  });

  it('produces no NaN or Infinity for 1 second of 440Hz sine', () => {
    const hp = new HysteresisProcessor(sampleRate);
    hp.setDrive(0.5);
    hp.setSaturation(0.5);
    hp.setWidth(0.5);

    const freq = 440;

    for (let i = 0; i < sampleRate; i++) {
      const x = Math.sin(2 * Math.PI * freq * i / sampleRate);
      const y = hp.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('generates harmonics: output is not a pure scaled sine', () => {
    const hp = new HysteresisProcessor(sampleRate);
    hp.setDrive(0.7);

    const freq = 440;
    const outputs: number[] = [];

    // Process 1 second of sine
    for (let i = 0; i < sampleRate; i++) {
      const x = Math.sin(2 * Math.PI * freq * i / sampleRate);
      outputs.push(hp.process(x));
    }

    // Find the peak output for normalization
    const maxOut = Math.max(...outputs.map(Math.abs));

    if (maxOut === 0) {
      // If output is zero, the test should fail — we expect harmonics
      expect(maxOut).toBeGreaterThan(0);
      return;
    }

    // Normalize output and compare to a pure sine at same frequency
    // Compute average absolute difference between normalized output and best-fit sine
    let totalDiff = 0;
    let count = 0;

    // Skip the first 1000 samples (transient) and use the steady-state portion
    for (let i = 1000; i < sampleRate; i++) {
      const normalizedOut = outputs[i] / maxOut;
      const referenceSine = Math.sin(2 * Math.PI * freq * i / sampleRate);
      totalDiff += Math.abs(normalizedOut - referenceSine);
      count++;
    }

    const avgDiff = totalDiff / count;

    // If the processor adds harmonics, the normalized output will differ
    // significantly from a pure sine
    expect(avgDiff).toBeGreaterThan(0.01);
  });

  it('produces no NaN with extreme drive and large input signal', () => {
    const hp = new HysteresisProcessor(sampleRate);
    hp.setDrive(1.0);
    hp.setSaturation(1.0);

    // Large input signal that can push Q > 500 (triggers cosh/sinh overflow guard)
    for (let i = 0; i < sampleRate; i++) {
      const x = 10.0 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
      const y = hp.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('remains finite and bounded under hot clipped transients at high sample rates', () => {
    const sr = 48000 * 8; // matches 8x oversampled worklet path
    const hp = new HysteresisProcessor(sr);
    hp.setDrive(1.0);
    hp.setSaturation(1.0);
    hp.setBias(0.1);
    hp.setK(0.3);
    hp.setAlpha(5e-3);

    let maxAbs = 0;
    for (let i = 0; i < sr; i++) {
      const t = i / sr;
      // Hot clipped fundamental plus HF edge content to stress dH/dt.
      const x =
        24 * Math.sign(Math.sin(2 * Math.PI * 70 * t)) +
        6 * Math.sin(2 * Math.PI * 11000 * t);
      const y = hp.process(x);
      expect(Number.isFinite(y)).toBe(true);
      maxAbs = Math.max(maxAbs, Math.abs(y));
    }

    // Guard against runaway outputs that can turn into broadband crackle/noise.
    expect(maxAbs).toBeLessThan(8);
  });

  describe('bias as reversibility (parametric bias model)', () => {
    it('setBias exists and accepts 0-1 range', () => {
      const hp = new HysteresisProcessor(sampleRate);
      expect(() => hp.setBias(0)).not.toThrow();
      expect(() => hp.setBias(0.5)).not.toThrow();
      expect(() => hp.setBias(1.0)).not.toThrow();
    });

    it('underbias (bias=0) produces more distortion than optimal bias (bias=0.5)', () => {
      const freq = 440;

      // Measure distortion with underbias (bias=0)
      const hpUnder = new HysteresisProcessor(sampleRate);
      hpUnder.setDrive(0.5);
      hpUnder.setBias(0);
      const outputsUnder: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsUnder.push(hpUnder.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Measure distortion with optimal bias (bias=0.5)
      const hpOptimal = new HysteresisProcessor(sampleRate);
      hpOptimal.setDrive(0.5);
      hpOptimal.setBias(0.5);
      const outputsOptimal: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsOptimal.push(hpOptimal.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Compute THD proxy: average absolute difference from best-fit sine
      function distortionProxy(outputs: number[]): number {
        const maxOut = Math.max(...outputs.slice(sampleRate / 2).map(Math.abs));
        if (maxOut < 0.001) return 0;
        let totalDiff = 0;
        let count = 0;
        for (let i = Math.floor(sampleRate / 2); i < sampleRate; i++) {
          const normalized = outputs[i] / maxOut;
          const ref = Math.sin(2 * Math.PI * freq * i / sampleRate);
          totalDiff += Math.abs(normalized - ref);
          count++;
        }
        return totalDiff / count;
      }

      const distUnder = distortionProxy(outputsUnder);
      const distOptimal = distortionProxy(outputsOptimal);

      // Underbias should produce noticeably more distortion
      expect(distUnder).toBeGreaterThan(distOptimal);
    });

    it('overbias (bias=1.0) produces more linear output than underbias', () => {
      const freq = 440;

      // Overbias
      const hpOver = new HysteresisProcessor(sampleRate);
      hpOver.setDrive(0.5);
      hpOver.setBias(1.0);
      const outputsOver: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsOver.push(hpOver.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Underbias
      const hpUnder = new HysteresisProcessor(sampleRate);
      hpUnder.setDrive(0.5);
      hpUnder.setBias(0);
      const outputsUnder: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsUnder.push(hpUnder.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Compute peak ratio for linearity: high linearity → output tracks input shape
      const maxOver = Math.max(...outputsOver.slice(sampleRate / 2).map(Math.abs));
      const maxUnder = Math.max(...outputsUnder.slice(sampleRate / 2).map(Math.abs));

      // Both should produce output
      expect(maxOver).toBeGreaterThan(0.01);
      expect(maxUnder).toBeGreaterThan(0.01);

      // Overbias should sound cleaner (less harmonic distortion)
      // We test by checking the output is closer to a scaled sine
      function sineFitError(outputs: number[]): number {
        const maxOut = Math.max(...outputs.slice(sampleRate / 2).map(Math.abs));
        if (maxOut < 0.001) return 0;
        let totalDiff = 0;
        let count = 0;
        for (let i = Math.floor(sampleRate / 2); i < sampleRate; i++) {
          const normalized = outputs[i] / maxOut;
          const ref = Math.sin(2 * Math.PI * freq * i / sampleRate);
          totalDiff += Math.abs(normalized - ref);
          count++;
        }
        return totalDiff / count;
      }

      const errorOver = sineFitError(outputsOver);
      const errorUnder = sineFitError(outputsUnder);

      // Overbias should be more linear (less error)
      expect(errorOver).toBeLessThan(errorUnder);
    });

    it('setBias does not produce NaN for any value in [0,1]', () => {
      const biasValues = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
      for (const bias of biasValues) {
        const hp = new HysteresisProcessor(sampleRate);
        hp.setDrive(0.5);
        hp.setBias(bias);
        for (let i = 0; i < 4410; i++) {
          const y = hp.process(0.5 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
          expect(Number.isFinite(y)).toBe(true);
        }
      }
    });
  });

  describe('per-preset tape formulation', () => {
    it('setAlpha method exists and accepts values', () => {
      const hp = new HysteresisProcessor(sampleRate);
      expect(() => hp.setAlpha(1.5e-3)).not.toThrow();
      expect(() => hp.setAlpha(2.0e-3)).not.toThrow();
    });

    it('different k values produce different saturation curves', () => {
      const freq = 440;

      // Low k (softer tape, easier to saturate)
      const hpLow = new HysteresisProcessor(sampleRate);
      hpLow.setDrive(0.5);
      hpLow.setK(0.3);
      let maxLow = 0;
      for (let i = 0; i < sampleRate; i++) {
        const y = hpLow.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate));
        if (i > sampleRate / 2) maxLow = Math.max(maxLow, Math.abs(y));
      }

      // High k (harder tape, more headroom)
      const hpHigh = new HysteresisProcessor(sampleRate);
      hpHigh.setDrive(0.5);
      hpHigh.setK(0.7);
      let maxHigh = 0;
      for (let i = 0; i < sampleRate; i++) {
        const y = hpHigh.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate));
        if (i > sampleRate / 2) maxHigh = Math.max(maxHigh, Math.abs(y));
      }

      // Different k should produce different output levels
      expect(maxLow).not.toBeCloseTo(maxHigh, 1);
    });

    it('different alpha values produce measurably different output', () => {
      const freq = 440;

      const hp1 = new HysteresisProcessor(sampleRate);
      hp1.setDrive(0.5);
      hp1.setAlpha(1.0e-3);
      const outputs1: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputs1.push(hp1.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      const hp2 = new HysteresisProcessor(sampleRate);
      hp2.setDrive(0.5);
      hp2.setAlpha(3.0e-3);
      const outputs2: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputs2.push(hp2.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Compute RMS difference
      let sumSq = 0;
      for (let i = Math.floor(sampleRate / 2); i < sampleRate; i++) {
        const diff = outputs1[i] - outputs2[i];
        sumSq += diff * diff;
      }
      const rmsDiff = Math.sqrt(sumSq / (sampleRate / 2));

      // Different alpha should produce measurably different output.
      // Alpha is a subtle parameter (inter-domain coupling), so the effect is small.
      expect(rmsDiff).toBeGreaterThan(1e-5);
    });
  });

  describe('tape formulation c as underbias floor', () => {
    it('setBaseC changes the underbias (bias=0) distortion character', () => {
      const freq = 440;

      // Low baseC (e.g., older tape stock with more irreversible domain walls)
      const hpLow = new HysteresisProcessor(sampleRate);
      hpLow.setDrive(0.5);
      hpLow.setBaseC(0.05);
      hpLow.setBias(0); // underbias: should use baseC=0.05
      const outputsLow: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsLow.push(hpLow.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // High baseC (e.g., modern tape with more reversible domains)
      const hpHigh = new HysteresisProcessor(sampleRate);
      hpHigh.setDrive(0.5);
      hpHigh.setBaseC(0.2);
      hpHigh.setBias(0); // underbias: should use baseC=0.2
      const outputsHigh: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsHigh.push(hpHigh.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Compute distortion proxy for each
      function distortionProxy(outputs: number[]): number {
        const steady = outputs.slice(Math.floor(sampleRate / 2));
        const maxOut = Math.max(...steady.map(Math.abs));
        if (maxOut < 0.001) return 0;
        let totalDiff = 0;
        for (let i = 0; i < steady.length; i++) {
          const idx = Math.floor(sampleRate / 2) + i;
          const normalized = steady[i] / maxOut;
          const ref = Math.sin(2 * Math.PI * freq * idx / sampleRate);
          totalDiff += Math.abs(normalized - ref);
        }
        return totalDiff / steady.length;
      }

      const distLow = distortionProxy(outputsLow);
      const distHigh = distortionProxy(outputsHigh);

      // Lower baseC → wider hysteresis loop at underbias → more distortion
      expect(distLow).toBeGreaterThan(distHigh);
    });

    it('setBaseC does not affect overbias behavior', () => {
      const freq = 440;

      // At full bias (1.0), c should be near 0.99 regardless of baseC
      const hp1 = new HysteresisProcessor(sampleRate);
      hp1.setDrive(0.5);
      hp1.setBaseC(0.05);
      hp1.setBias(1.0);
      const outputs1: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputs1.push(hp1.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      const hp2 = new HysteresisProcessor(sampleRate);
      hp2.setDrive(0.5);
      hp2.setBaseC(0.2);
      hp2.setBias(1.0);
      const outputs2: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputs2.push(hp2.process(0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // At full bias, both should produce very similar output
      let maxDiff = 0;
      for (let i = Math.floor(sampleRate / 2); i < sampleRate; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(outputs1[i] - outputs2[i]));
      }

      // Should be very close (both converge toward c≈0.99 at signal peaks)
      // With adaptive c, baseC has slightly more influence at peaks, so allow 0.05
      expect(maxDiff).toBeLessThan(0.05);
    });
  });

  describe('signal-adaptive bias reversibility', () => {
    it('loud signal at moderate bias produces more distortion than quiet signal', () => {
      const freq = 440;

      // Quiet signal (amplitude 0.1) with moderate bias
      const hpQuiet = new HysteresisProcessor(sampleRate);
      hpQuiet.setDrive(0.5);
      hpQuiet.setBias(0.5);
      const outputsQuiet: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsQuiet.push(hpQuiet.process(0.1 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      // Loud signal (amplitude 1.0) with same moderate bias
      const hpLoud = new HysteresisProcessor(sampleRate);
      hpLoud.setDrive(0.5);
      hpLoud.setBias(0.5);
      const outputsLoud: number[] = [];
      for (let i = 0; i < sampleRate; i++) {
        outputsLoud.push(hpLoud.process(1.0 * Math.sin(2 * Math.PI * freq * i / sampleRate)));
      }

      function distortionProxy(outputs: number[]): number {
        const steady = outputs.slice(Math.floor(sampleRate / 2));
        const maxOut = Math.max(...steady.map(Math.abs));
        if (maxOut < 0.001) return 0;
        let totalDiff = 0;
        for (let i = 0; i < steady.length; i++) {
          const idx = Math.floor(sampleRate / 2) + i;
          const normalized = steady[i] / maxOut;
          const ref = Math.sin(2 * Math.PI * freq * idx / sampleRate);
          totalDiff += Math.abs(normalized - ref);
        }
        return totalDiff / steady.length;
      }

      const distQuiet = distortionProxy(outputsQuiet);
      const distLoud = distortionProxy(outputsLoud);

      // Loud signal overwhelms bias → lower effective c → more distortion
      expect(distLoud).toBeGreaterThan(distQuiet);
    });

    it('getEffectiveC(0) returns C_MAX when bias > 0', () => {
      const hp = new HysteresisProcessor(sampleRate);
      hp.setBias(0.5);
      // At H=0, bias dominates: c_eff = baseC + (0.99 - baseC) * biasAmp / biasAmp = 0.99
      expect(hp.getEffectiveC(0)).toBeCloseTo(0.99, 5);
    });

    it('getEffectiveC decreases as |H| increases', () => {
      const hp = new HysteresisProcessor(sampleRate);
      hp.setBias(0.5);

      const cAtZero = hp.getEffectiveC(0);
      const cAtSmall = hp.getEffectiveC(0.1);
      const cAtMedium = hp.getEffectiveC(0.5);
      const cAtLarge = hp.getEffectiveC(2.0);

      expect(cAtZero).toBeGreaterThan(cAtSmall);
      expect(cAtSmall).toBeGreaterThan(cAtMedium);
      expect(cAtMedium).toBeGreaterThan(cAtLarge);
    });

    it('setC disables adaptive mode (flat c regardless of H)', () => {
      const hp = new HysteresisProcessor(sampleRate);
      hp.setBias(0.5); // enable adaptive mode
      hp.setC(0.3); // should disable adaptive mode

      // Should return flat c=0.3 regardless of H
      expect(hp.getEffectiveC(0)).toBeCloseTo(0.3, 5);
      expect(hp.getEffectiveC(0.5)).toBeCloseTo(0.3, 5);
      expect(hp.getEffectiveC(2.0)).toBeCloseTo(0.3, 5);
    });

    it('setBias(0) gives flat c = baseC for all H values', () => {
      const hp = new HysteresisProcessor(sampleRate);
      hp.setBaseC(0.15);
      hp.setBias(0); // biasAmplitude=0, biasActive=true

      // With biasAmplitude=0, denomSq = H*H, biasAmp/sqrt(denomSq) = 0
      // So c_eff = baseC for all H
      // At H=0, denomSq < 1e-20, returns baseC directly
      expect(hp.getEffectiveC(0)).toBeCloseTo(0.15, 5);
      expect(hp.getEffectiveC(0.5)).toBeCloseTo(0.15, 5);
      expect(hp.getEffectiveC(2.0)).toBeCloseTo(0.15, 5);
    });

    it('no NaN with adaptive bias at extreme signal levels', () => {
      const hp = new HysteresisProcessor(sampleRate);
      hp.setDrive(1.0);
      hp.setSaturation(1.0);
      hp.setBias(0.7);

      for (let i = 0; i < sampleRate; i++) {
        const x = 10.0 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
        const y = hp.process(x);
        expect(Number.isFinite(y)).toBe(true);
      }
    });
  });

  describe('getSaturationDepth', () => {
    it('returns 0 when no signal has been processed', () => {
      const proc = new HysteresisProcessor(48000);
      expect(proc.getSaturationDepth()).toBe(0);
    });

    it('increases with louder input signals', () => {
      const proc = new HysteresisProcessor(48000);
      for (let i = 0; i < 100; i++) proc.process(0.3 * Math.sin(i * 0.1));
      const depthLow = proc.getSaturationDepth();

      const proc2 = new HysteresisProcessor(48000);
      for (let i = 0; i < 100; i++) proc2.process(0.9 * Math.sin(i * 0.1));
      const depthHigh = proc2.getSaturationDepth();

      expect(depthHigh).toBeGreaterThan(depthLow);
      expect(depthLow).toBeGreaterThanOrEqual(0);
      expect(depthHigh).toBeLessThanOrEqual(1);
    });
  });

  it('reset clears state: process(0) returns 0 after reset', () => {
    const hp = new HysteresisProcessor(sampleRate);
    hp.setDrive(0.5);

    const freq = 440;

    // Process some audio to build up state
    for (let i = 0; i < 1000; i++) {
      const x = Math.sin(2 * Math.PI * freq * i / sampleRate);
      hp.process(x);
    }

    // Reset the processor
    hp.reset();

    // After reset, processing zero should return zero
    const out = hp.process(0);
    expect(out).toBe(0);
  });
});
