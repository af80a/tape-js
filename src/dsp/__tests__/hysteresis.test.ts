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
