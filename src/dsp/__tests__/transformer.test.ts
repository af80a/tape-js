import { describe, it, expect } from 'vitest';
import { TransformerModel } from '../transformer';

describe('TransformerModel', () => {
  const sampleRate = 44100;

  it('produces no NaN for 1 second of 440 Hz sine', () => {
    const transformer = new TransformerModel(sampleRate);
    const numSamples = sampleRate; // 1 second

    for (let i = 0; i < numSamples; i++) {
      const x = Math.sin(2 * Math.PI * 440 * i / sampleRate);
      const y = transformer.process(x);
      expect(y).not.toBeNaN();
    }
  });

  it('attenuates 5 Hz signal relative to 1 kHz (LF coupling)', () => {
    const fs = sampleRate;

    // Measure RMS of 5 Hz through the transformer
    const tfLow = new TransformerModel(fs);
    let sumSqLow = 0;
    const numSamples = fs; // 1 second
    for (let i = 0; i < numSamples; i++) {
      const x = 0.1 * Math.sin(2 * Math.PI * 5 * i / fs);
      const y = tfLow.process(x);
      // Only measure steady-state (skip first 0.2s for transient)
      if (i >= Math.floor(fs * 0.2)) {
        sumSqLow += y * y;
      }
    }
    const rmsLow = Math.sqrt(sumSqLow / (numSamples - Math.floor(fs * 0.2)));

    // Measure RMS of 1 kHz through the transformer
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

    // 5 Hz should be significantly attenuated compared to 1 kHz
    expect(rmsLow).toBeLessThan(rmsMid * 0.5);
  });

  it('saturates at high levels: 10x input does NOT produce 10x output', () => {
    const fs = sampleRate;
    const numSamples = Math.floor(fs * 0.5); // 0.5 seconds
    const freq = 440;

    // Measure peak output at low amplitude
    const tfLow = new TransformerModel(fs, { satAmount: 1.0 });
    let maxLow = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = 0.1 * Math.sin(2 * Math.PI * freq * i / fs);
      const y = tfLow.process(x);
      if (i >= Math.floor(fs * 0.1)) {
        maxLow = Math.max(maxLow, Math.abs(y));
      }
    }

    // Measure peak output at 10x amplitude
    const tfHigh = new TransformerModel(fs, { satAmount: 1.0 });
    let maxHigh = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = 1.0 * Math.sin(2 * Math.PI * freq * i / fs);
      const y = tfHigh.process(x);
      if (i >= Math.floor(fs * 0.1)) {
        maxHigh = Math.max(maxHigh, Math.abs(y));
      }
    }

    // The ratio should be less than 8 (compressed by saturation)
    const ratio = maxHigh / maxLow;
    expect(ratio).toBeLessThan(8);
    // But it should still be greater than 1 (output does increase)
    expect(ratio).toBeGreaterThan(1);
  });
});
