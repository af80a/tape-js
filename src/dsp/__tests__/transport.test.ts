import { describe, it, expect } from 'vitest';
import { TransportModel } from '../transport';

describe('TransportModel', () => {
  const fs = 44100;

  it('no NaN with wow=0.5, flutter=0.5 for 1s of 440Hz', () => {
    const transport = new TransportModel(fs);
    transport.setWow(0.5);
    transport.setFlutter(0.5);

    const numSamples = fs; // 1 second
    for (let i = 0; i < numSamples; i++) {
      const x = Math.sin((2 * Math.PI * 440 * i) / fs);
      const y = transport.process(x);
      expect(y).not.toBeNaN();
    }
  });

  it('with zero wow/flutter, output amplitude matches input (0.8 < maxOut < 1.2)', () => {
    const transport = new TransportModel(fs);
    transport.setWow(0);
    transport.setFlutter(0);

    const numSamples = fs; // 1 second
    let maxOut = 0;
    for (let i = 0; i < numSamples; i++) {
      const x = Math.sin((2 * Math.PI * 440 * i) / fs);
      const y = transport.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeGreaterThan(0.8);
    expect(maxOut).toBeLessThan(1.2);
  });
});
