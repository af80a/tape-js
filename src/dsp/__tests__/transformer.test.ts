import { describe, it, expect } from 'vitest';
import { TransformerModel } from '../transformer';

describe('TransformerModel', () => {
  const sampleRate = 44100;

  it('produces no NaN for 1 second of 440 Hz sine', () => {
    const transformer = new TransformerModel(sampleRate);
    const numSamples = sampleRate;

    for (let i = 0; i < numSamples; i++) {
      const x = Math.sin(2 * Math.PI * 440 * i / sampleRate);
      const y = transformer.process(x);
      expect(y).not.toBeNaN();
    }
  });

  it('attenuates 5 Hz signal relative to 1 kHz (LF coupling)', () => {
    const fs = sampleRate;

    const tfLow = new TransformerModel(fs);
    let sumSqLow = 0;
    const numSamples = fs;
    for (let i = 0; i < numSamples; i++) {
      const x = 0.1 * Math.sin(2 * Math.PI * 5 * i / fs);
      const y = tfLow.process(x);
      if (i >= Math.floor(fs * 0.2)) {
        sumSqLow += y * y;
      }
    }
    const rmsLow = Math.sqrt(sumSqLow / (numSamples - Math.floor(fs * 0.2)));

    const tfMid = new TransformerModel(fs);
    let sumSqMid = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = 0.1 * Math.sin(2 * Math.PI * 1000 * i / fs);
      const y = tfMid.process(x);
      if (i >= Math.floor(fs * 0.2)) {
        sumSqMid += y * y;
      }
    }
    const rmsMid = Math.sqrt(sumSqMid / (numSamples - Math.floor(fs * 0.2)));

    expect(rmsLow).toBeLessThan(rmsMid * 0.5);
  });

  it('saturates at low frequencies: 80 Hz shows waveform distortion', () => {
    const fs = sampleRate;
    const numSamples = Math.floor(fs * 0.5);
    // Use 80 Hz — near the core stiffness reference frequency.
    // Flux-based saturation distorts zero crossings (not peaks) because
    // flux is 90° out of phase with voltage. This is physically correct —
    // the test measures RMS compression (energy), not peak compression.
    const freq = 80;
    const skipSamples = Math.floor(fs * 0.1);

    // RMS at low amplitude (nearly linear)
    const tfLow = new TransformerModel(fs, { satAmount: 1.5 });
    let sumSqLow = 0;
    let countLow = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = 0.1 * Math.sin(2 * Math.PI * freq * i / fs);
      const y = tfLow.process(x);
      if (i >= skipSamples) { sumSqLow += y * y; countLow++; }
    }
    const rmsLow = Math.sqrt(sumSqLow / countLow);

    // RMS at high amplitude (should show saturation)
    const tfHigh = new TransformerModel(fs, { satAmount: 1.5 });
    let sumSqHigh = 0;
    let countHigh = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = 1.0 * Math.sin(2 * Math.PI * freq * i / fs);
      const y = tfHigh.process(x);
      if (i >= skipSamples) { sumSqHigh += y * y; countHigh++; }
    }
    const rmsHigh = Math.sqrt(sumSqHigh / countHigh);

    // A linear system would give RMS ratio = 10.
    // With saturation, the RMS ratio should be noticeably less.
    const ratio = rmsHigh / rmsLow;
    expect(ratio).toBeLessThan(9.5);
    expect(ratio).toBeGreaterThan(1);
  });

  it('frequency-dependent saturation: 80 Hz compresses more than 1 kHz', () => {
    const fs = sampleRate;
    const numSamples = Math.floor(fs * 0.5);
    const amplitude = 0.8;

    // Process 80 Hz — should show noticeable saturation
    const tfLow = new TransformerModel(fs, { satAmount: 1.5 });
    let maxLow = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = amplitude * Math.sin(2 * Math.PI * 80 * i / fs);
      const y = tfLow.process(x);
      if (i >= Math.floor(fs * 0.1)) maxLow = Math.max(maxLow, Math.abs(y));
    }

    // Process 1 kHz — should be nearly linear (little flux accumulation)
    const tfHigh = new TransformerModel(fs, { satAmount: 1.5 });
    let maxHigh = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = amplitude * Math.sin(2 * Math.PI * 1000 * i / fs);
      const y = tfHigh.process(x);
      if (i >= Math.floor(fs * 0.1)) maxHigh = Math.max(maxHigh, Math.abs(y));
    }

    // 80 Hz should be compressed more (lower peak) than 1 kHz
    // because low frequencies accumulate more flux in the core
    expect(maxLow).toBeLessThan(maxHigh);
  });

  it('satAmount=0 then restore: sound comes back without NaN', () => {
    const fs = sampleRate;
    const tf = new TransformerModel(fs, { satAmount: 1.0 });
    const freq = 440;

    // Process normally for 0.1s
    for (let i = 0; i < Math.floor(fs * 0.1); i++) {
      tf.process(0.5 * Math.sin(2 * Math.PI * freq * i / fs));
    }

    // Set satAmount to 0
    tf.reconfigure({ satAmount: 0 });
    for (let i = 0; i < Math.floor(fs * 0.1); i++) {
      const y = tf.process(0.5 * Math.sin(2 * Math.PI * freq * i / fs));
      expect(Number.isFinite(y)).toBe(true);
    }

    // Restore satAmount — sound must come back, no NaN
    tf.reconfigure({ satAmount: 1.0 });
    let maxOut = 0;
    for (let i = 0; i < Math.floor(fs * 0.2); i++) {
      const y = tf.process(0.5 * Math.sin(2 * Math.PI * freq * i / fs));
      expect(Number.isFinite(y)).toBe(true);
      if (i >= Math.floor(fs * 0.05)) {
        maxOut = Math.max(maxOut, Math.abs(y));
      }
    }

    // Sound must be present after restoring saturation
    expect(maxOut).toBeGreaterThan(0.1);
  });

  it('large satAmount jumps do not create runaway transients', () => {
    const fs = sampleRate;
    const tf = new TransformerModel(fs, { satAmount: 1.5, lfCutoff: 5 });
    const freq = 80;

    // Build up realistic flux state at strong LF.
    for (let i = 0; i < Math.floor(fs * 0.2); i++) {
      tf.process(0.9 * Math.sin(2 * Math.PI * freq * i / fs));
    }

    // Abruptly reduce satAmount near bypass, then restore.
    tf.reconfigure({ satAmount: 0.001 });
    let maxAfterDrop = 0;
    for (let i = 0; i < 256; i++) {
      const y = tf.process(0.9 * Math.sin(2 * Math.PI * freq * i / fs));
      expect(Number.isFinite(y)).toBe(true);
      maxAfterDrop = Math.max(maxAfterDrop, Math.abs(y));
    }

    tf.reconfigure({ satAmount: 1.5 });
    let maxAfterRestore = 0;
    for (let i = 0; i < 256; i++) {
      const y = tf.process(0.9 * Math.sin(2 * Math.PI * freq * i / fs));
      expect(Number.isFinite(y)).toBe(true);
      maxAfterRestore = Math.max(maxAfterRestore, Math.abs(y));
    }

    // Regression: parameter jumps should not inject huge impulses.
    expect(maxAfterDrop).toBeLessThan(5);
    expect(maxAfterRestore).toBeLessThan(5);
  });

  describe('eddy current losses', () => {
    /**
     * Helper: measure peak output of a sine at a given frequency
     * through a transformer, skipping the transient.
     */
    function measurePeak(freq: number, fs: number, options?: { satAmount?: number; lfCutoff?: number }): number {
      const tf = new TransformerModel(fs, { satAmount: 0, lfCutoff: 5, ...options });
      const numSamples = Math.floor(fs * 0.5);
      let maxOut = 0;
      for (let i = 0; i < numSamples; i++) {
        const x = 0.3 * Math.sin(2 * Math.PI * freq * i / fs);
        const y = tf.process(x);
        if (i >= Math.floor(fs * 0.2)) maxOut = Math.max(maxOut, Math.abs(y));
      }
      return maxOut;
    }

    it('15kHz is attenuated relative to 1kHz by eddy current losses', () => {
      const fs = sampleRate;
      // With saturation off and low HPF, the only HF attenuation comes from
      // the resonant LPF and (new) eddy current filter.
      const peak1k = measurePeak(1000, fs);
      const peak15k = measurePeak(15000, fs);

      // 15kHz should be noticeably attenuated. The existing resonant LPF at
      // 50kHz barely touches 15kHz. With eddy current losses (first-order LP
      // at ~35kHz), there should be measurable attenuation.
      const gainDb = 20 * Math.log10(peak15k / peak1k);
      // Expect at least 0.5 dB of loss at 15kHz from eddy currents
      expect(gainDb).toBeLessThan(-0.5);
    });

    it('eddy current loss is progressive (more at 18kHz than 10kHz)', () => {
      const fs = sampleRate;
      const peak10k = measurePeak(10000, fs);
      const peak18k = measurePeak(18000, fs);

      // Higher frequency should have more eddy current loss
      expect(peak18k).toBeLessThan(peak10k);
    });
  });

  describe('per-preset core asymmetry', () => {
    it('asymmetry parameter changes saturation character proportionally', () => {
      // The asymmetry term asym*phi/(1+phi²) is an odd function of phi — it
      // modifies the shape of the B-H curve (adding a Lorentzian component)
      // and therefore changes odd-harmonic content, not even harmonics or DC.
      // We verify that higher asymmetry produces a measurably larger deviation
      // from the zero-asymmetry reference, and that the effect scales with value.
      const fs = sampleRate;
      const numSamples = Math.floor(fs * 0.2);
      const warmup   = Math.floor(fs * 0.05);
      const freq = 80;

      const tfZero = new TransformerModel(fs, { satAmount: 1.5, asymmetry: 0 });
      const tfLow  = new TransformerModel(fs, { satAmount: 1.5, asymmetry: 0.005 });
      const tfHigh = new TransformerModel(fs, { satAmount: 1.5, asymmetry: 0.04 });

      let diffLow = 0, diffHigh = 0;
      for (let i = 0; i < numSamples; i++) {
        const x = 0.5 * Math.sin(2 * Math.PI * freq * i / fs);
        const yZero = tfZero.process(x);
        const yLow  = tfLow.process(x);
        const yHigh = tfHigh.process(x);
        if (i >= warmup) {
          diffLow  += Math.abs(yLow  - yZero);
          diffHigh += Math.abs(yHigh - yZero);
        }
      }

      // Higher asymmetry deviates more from the zero-asymmetry reference
      expect(diffHigh).toBeGreaterThan(diffLow);
      // Even the low value has a measurable effect
      expect(diffLow).toBeGreaterThan(0);
    });

    it('reconfigure updates asymmetry', () => {
      const fs = sampleRate;
      const tf = new TransformerModel(fs, { satAmount: 1.5, asymmetry: 0.005 });

      // Process some audio
      for (let i = 0; i < 1000; i++) {
        tf.process(0.5 * Math.sin(2 * Math.PI * 80 * i / fs));
      }

      // Reconfigure with higher asymmetry — should not throw
      expect(() => tf.reconfigure({ asymmetry: 0.04 })).not.toThrow();

      // Continue processing — no NaN
      for (let i = 0; i < 1000; i++) {
        const y = tf.process(0.5 * Math.sin(2 * Math.PI * 80 * i / fs));
        expect(Number.isFinite(y)).toBe(true);
      }
    });
  });

  describe('getSaturationDepth', () => {
    it('returns 0 when no signal has been processed', () => {
      const xfmr = new TransformerModel(48000);
      expect(xfmr.getSaturationDepth()).toBe(0);
    });

    it('returns higher value when driven harder', () => {
      const xfmr1 = new TransformerModel(48000, { satAmount: 1.0 });
      const xfmr2 = new TransformerModel(48000, { satAmount: 2.0 });

      for (let i = 0; i < 500; i++) {
        const sample = 0.5 * Math.sin(2 * Math.PI * 60 * i / 48000);
        xfmr1.process(sample);
        xfmr2.process(sample);
      }

      expect(xfmr2.getSaturationDepth()).toBeGreaterThan(xfmr1.getSaturationDepth());
      expect(xfmr1.getSaturationDepth()).toBeGreaterThanOrEqual(0);
      expect(xfmr2.getSaturationDepth()).toBeLessThanOrEqual(1);
    });
  });

  it('satAmount=0 bypasses saturation (linear passthrough)', () => {
    const fs = sampleRate;
    const tf = new TransformerModel(fs, { satAmount: 0, lfCutoff: 5 });
    const numSamples = Math.floor(fs * 0.2);

    // Process a 1 kHz sine and verify output tracks input closely
    let maxDiff = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 1000 * i / fs);
      const y = tf.process(x);
      if (i >= Math.floor(fs * 0.05)) {
        maxDiff = Math.max(maxDiff, Math.abs(y - x));
      }
    }

    // With saturation off and lfCutoff very low, output should be nearly identical
    // (small difference from filters only)
    expect(maxDiff).toBeLessThan(0.05);
  });
});
