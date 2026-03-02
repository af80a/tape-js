import { describe, it, expect } from 'vitest';
import { BiasOscillator, BIAS_CARRIER_BASE } from '../bias';

describe('BiasOscillator', () => {
  const fs = 88200; // typical oversampled rate (44100 * 2)

  it('peak output on zero input matches BIAS_CARRIER_BASE * depth', () => {
    const bias = new BiasOscillator(fs);
    bias.setLevel(1.0);

    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const y = bias.process(0);
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeCloseTo(BIAS_CARRIER_BASE * 1.0, 1);
  });

  it('level=1.0 produces ~0.5, consistent with J-A model H-field scale', () => {
    const bias = new BiasOscillator(fs);
    bias.setLevel(1.0);

    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const y = bias.process(0);
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeCloseTo(0.5, 1);
    expect(maxOut).toBeLessThan(0.6);
  });

  it('level=0.5 (typical preset) produces carrier amplitude of ~0.25', () => {
    const bias = new BiasOscillator(fs);
    bias.setLevel(0.5);

    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const y = bias.process(0);
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeCloseTo(BIAS_CARRIER_BASE * 0.5, 1);
  });

  it('level=2.0 (overbias) produces carrier amplitude of ~1.0', () => {
    const bias = new BiasOscillator(fs);
    bias.setLevel(2.0);

    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const y = bias.process(0);
      maxOut = Math.max(maxOut, Math.abs(y));
    }

    expect(maxOut).toBeCloseTo(BIAS_CARRIER_BASE * 2.0, 1);
  });

  it('clamps depth to [0, 2]', () => {
    const bias = new BiasOscillator(fs);

    bias.setLevel(-0.5);
    let maxOut = 0;
    for (let i = 0; i < 1000; i++) {
      maxOut = Math.max(maxOut, Math.abs(bias.process(0)));
    }
    expect(maxOut).toBe(0);

    bias.reset();
    bias.setLevel(5.0);
    maxOut = 0;
    for (let i = 0; i < fs; i++) {
      maxOut = Math.max(maxOut, Math.abs(bias.process(0)));
    }
    expect(maxOut).toBeCloseTo(BIAS_CARRIER_BASE * 2.0, 1);
  });
});
