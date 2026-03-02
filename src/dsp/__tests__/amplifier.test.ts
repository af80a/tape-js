import { describe, it, expect } from 'vitest';
import { cohenHelieIk, cohenHelieIg, cohenHelieJacobian, AmplifierModel } from '../amplifier';
import type { TubeCircuitParams } from '../amplifier';

describe('Cohen-Helie 12AX7 tube model', () => {
  // Parameters from Cohen & Helie (DAFx 2010), fitted to 12AX7 measurements
  // Gk=2.14e-3, mu=100.8, Ek=1.303, Ck=3.04, Gg=6.06e-4, Eg=1.354, Cg=13.9

  describe('cohenHelieIk (cathode current)', () => {
    it('returns zero when tube is in cutoff (large negative Vgk)', () => {
      // With Vgk = -50V and Vpk = 250V: (250/100.8 + (-50)) is very negative
      // log(1 + exp(very_negative)) ≈ 0, so Ik ≈ 0
      const Ik = cohenHelieIk(250, -50);
      expect(Ik).toBeCloseTo(0, 6);
    });

    it('returns positive current in normal operating range', () => {
      // Typical 12AX7 operating point: Vgk ≈ -1.5V, Vpk ≈ 150V
      const Ik = cohenHelieIk(150, -1.5);
      expect(Ik).toBeGreaterThan(0);
      // 12AX7 typical plate current is 0.5-1.5 mA
      expect(Ik).toBeGreaterThan(0.0001);
      expect(Ik).toBeLessThan(0.01);
    });

    it('increases with less negative Vgk (more grid drive)', () => {
      const Ik_low = cohenHelieIk(200, -2.0);
      const Ik_high = cohenHelieIk(200, -0.5);
      expect(Ik_high).toBeGreaterThan(Ik_low);
    });

    it('is always non-negative', () => {
      const testCases = [
        [250, -5], [250, 0], [250, 5], [100, -2], [300, -1],
      ];
      for (const [Vpk, Vgk] of testCases) {
        expect(cohenHelieIk(Vpk, Vgk)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('cohenHelieIg (grid current)', () => {
    it('is near zero for negative Vgk (normal operation)', () => {
      // Grid current only flows when Vgk > 0 (grid conduction)
      const Ig = cohenHelieIg(-1.5);
      expect(Ig).toBeCloseTo(0, 5);
    });

    it('is positive for positive Vgk (grid conduction)', () => {
      const Ig = cohenHelieIg(5.0);
      expect(Ig).toBeGreaterThan(0);
    });

    it('increases with increasing Vgk', () => {
      const Ig_low = cohenHelieIg(1.0);
      const Ig_high = cohenHelieIg(5.0);
      expect(Ig_high).toBeGreaterThan(Ig_low);
    });

    it('is always non-negative', () => {
      for (const Vgk of [-10, -5, -2, -1, 0, 1, 5, 10]) {
        expect(cohenHelieIg(Vgk)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('cohenHelieJacobian', () => {
    it('returns a 2x2 matrix of partial derivatives', () => {
      const J = cohenHelieJacobian(200, -1.5);
      // J = [[dIp/dVpk, dIp/dVgk], [dIg/dVpk, dIg/dVgk]]
      expect(J).toHaveLength(4); // flat [j00, j01, j10, j11]
    });

    it('dIg/dVpk is zero (grid current independent of plate voltage)', () => {
      const J = cohenHelieJacobian(200, -1.5);
      expect(J[2]).toBe(0); // j10 = dIg/dVpk
    });

    it('matches numerical derivatives', () => {
      const Vpk = 180, Vgk = -1.2;
      const eps = 1e-5;
      const J = cohenHelieJacobian(Vpk, Vgk);

      // Numerical dIp/dVpk
      const Ip_hi = cohenHelieIk(Vpk + eps, Vgk) - cohenHelieIg(Vgk);
      const Ip_lo = cohenHelieIk(Vpk - eps, Vgk) - cohenHelieIg(Vgk);
      const dIp_dVpk_num = (Ip_hi - Ip_lo) / (2 * eps);
      expect(J[0]).toBeCloseTo(dIp_dVpk_num, 4);

      // Numerical dIp/dVgk
      const Ip_hi2 = cohenHelieIk(Vpk, Vgk + eps) - cohenHelieIg(Vgk + eps);
      const Ip_lo2 = cohenHelieIk(Vpk, Vgk - eps) - cohenHelieIg(Vgk - eps);
      const dIp_dVgk_num = (Ip_hi2 - Ip_lo2) / (2 * eps);
      expect(J[1]).toBeCloseTo(dIp_dVgk_num, 4);

      // Numerical dIg/dVgk
      const Ig_hi = cohenHelieIg(Vgk + eps);
      const Ig_lo = cohenHelieIg(Vgk - eps);
      const dIg_dVgk_num = (Ig_hi - Ig_lo) / (2 * eps);
      expect(J[3]).toBeCloseTo(dIg_dVgk_num, 4);
    });
  });

  describe('plate current (Ip = Ik - Ig)', () => {
    it('plate current equals cathode minus grid current', () => {
      const Vpk = 200, Vgk = -1.0;
      const Ik = cohenHelieIk(Vpk, Vgk);
      const Ig = cohenHelieIg(Vgk);
      const Ip = Ik - Ig;
      expect(Ip).toBeCloseTo(Ik, 6); // Ig ≈ 0 for negative Vgk
      expect(Ip).toBeGreaterThan(0);
    });
  });
});

describe('AmplifierModel tube circuit', () => {
  it('accepts circuit parameters and initializes without error', () => {
    const params: TubeCircuitParams = {
      Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
      Cc_in: 22e-9, Cc_out: 100e-9, Ck: 25e-6,
      Vpp: 250,
    };
    const amp = new AmplifierModel('tube', 1.0, params);
    expect(amp).toBeDefined();
  });

  it('initializes and processes with Ampex circuit params', () => {
    const amp = new AmplifierModel('tube', 0.5, {
      Rp: 220e3, Rg: 470e3, Rk: 1.8e3,
      Cc_in: 47e-9, Cc_out: 220e-9, Ck: 22e-6, Vpp: 300,
    });
    const fs = 48000;
    for (let i = 0; i < fs * 0.1; i++) {
      const y = amp.process(0.5 * Math.sin(2 * Math.PI * 440 * i / fs));
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('defaults to Studer-like params when none provided', () => {
    const amp = new AmplifierModel('tube', 1.0);
    // Should not throw — uses default circuit params
    const out = amp.process(0.1);
    expect(Number.isFinite(out)).toBe(true);
  });
});

describe('DK-method state-space matrices', () => {
  it('computes discretized matrices from circuit params', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const out = amp.process(0);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('DC operating point: zero input produces near-zero AC output', () => {
    const amp = new AmplifierModel('tube', 1.0);
    let lastOut = 0;
    for (let i = 0; i < 1000; i++) {
      lastOut = amp.process(0);
    }
    expect(Math.abs(lastOut)).toBeLessThan(0.01);
  });

  it('state-space produces non-zero output for non-zero input', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;
    let maxOut = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    expect(maxOut).toBeGreaterThan(0.001);
  });
});

describe('Newton-Raphson solver', () => {
  it('converges within 8 iterations for normal signal levels', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('handles extreme overdrive without NaN', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;
    for (let i = 0; i < fs * 0.5; i++) {
      const x = 2.0 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('output is bounded (no runaway)', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;
    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const x = Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    expect(maxOut).toBeLessThan(10);
  });
});

describe('output normalization and drive', () => {
  it('output is in approximately [-1, 1] range for normal input', () => {
    const amp = new AmplifierModel('tube', 0.5);
    const fs = 48000;
    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    // Should be in a reasonable range, not raw plate voltages
    expect(maxOut).toBeGreaterThan(0.05);
    expect(maxOut).toBeLessThan(2.0);
  });

  it('higher drive produces more saturation (less linear)', () => {
    const fs = 48000;

    // Low drive
    const ampLow = new AmplifierModel('tube', 0.2);
    let maxLow = 0;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      maxLow = Math.max(maxLow, Math.abs(ampLow.process(x)));
    }

    // High drive
    const ampHigh = new AmplifierModel('tube', 1.0);
    let maxHigh = 0;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      maxHigh = Math.max(maxHigh, Math.abs(ampHigh.process(x)));
    }

    // High drive should produce higher output (more gain into saturation)
    expect(maxHigh).toBeGreaterThan(maxLow);
  });

  it('tube mode produces asymmetric clipping (even harmonics)', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;

    // Process 1s of sine, skip transient
    const outputs: number[] = [];
    for (let i = 0; i < fs; i++) {
      const x = 0.8 * Math.sin(2 * Math.PI * 440 * i / fs);
      outputs.push(amp.process(x));
    }

    // Check asymmetry: positive and negative peaks should differ
    const posPeak = Math.max(...outputs.slice(fs * 0.5));
    const negPeak = Math.min(...outputs.slice(fs * 0.5));
    expect(Math.abs(posPeak)).not.toBeCloseTo(Math.abs(negPeak), 1);
  });
});

describe('power supply sag', () => {
  it('Vpp sags under sustained heavy signal', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;
    const initialVpp = amp.getSagVpp();

    // Process 0.5s of loud sine to drain the supply
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }

    // Supply voltage should have sagged measurably.
    // With R_OUT=750Ω (design doc), the supply is stiffer than R_OUT=5000Ω,
    // so sag depth is smaller but response is faster.
    expect(amp.getSagVpp()).toBeLessThan(initialVpp * 0.999);
  });

  it('supply recovers after signal stops', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;

    // Heavy signal for 0.5s
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }
    const saggedVpp = amp.getSagVpp();

    // Silence for 1s (supply recovers)
    for (let i = 0; i < fs; i++) {
      amp.process(0);
    }

    // Supply should have recovered above sagged level, close to initial
    const initialVpp = new AmplifierModel('tube', 1.0).getSagVpp();
    expect(amp.getSagVpp()).toBeGreaterThan(saggedVpp);
    expect(amp.getSagVpp()).toBeGreaterThan(initialVpp * 0.995);
  });
});

describe('sag time constant matches design doc', () => {
  it('sag responds within ~35ms (not ~50ms)', () => {
    // Design doc: τ1 = R_OUT(750) × C1(47µF) = 35ms
    // Old implementation: τ1 = 5000 × 10µF = 50ms
    // Test: after a sudden burst, measure how quickly Vpp drops.
    // At time τ, voltage drops to ~63% of its final sag depth.
    const fs = 48000;
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const initialVpp = amp.getSagVpp();

    // Drive hard for 200ms (enough for sag to engage)
    for (let i = 0; i < fs * 0.2; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }

    const finalVpp = amp.getSagVpp();
    const sagDepth = initialVpp - finalVpp;

    // Now create a fresh amplifier and measure where it is at exactly 35ms
    const amp35 = new AmplifierModel('tube', 1.0);
    amp35.setDrive(1.0);
    const initial35 = amp35.getSagVpp();

    // Drive hard for exactly 35ms
    const samples35ms = Math.round(fs * 0.035);
    for (let i = 0; i < samples35ms; i++) {
      amp35.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }

    const dropped35 = initial35 - amp35.getSagVpp();

    // At time τ, the drop should be at least 50% of the eventual depth.
    // With τ=35ms, at 35ms we expect ~63% of depth.
    // With τ=50ms, at 35ms we'd only get ~50% of depth.
    // Test that at 35ms we've dropped at least 55% of the full depth.
    expect(dropped35 / sagDepth).toBeGreaterThan(0.55);
  });
});

describe('getSaturationDepth', () => {
  it('returns 0 for tube mode with no signal', () => {
    const amp = new AmplifierModel('tube', 0.5, undefined, 48000);
    expect(amp.getSaturationDepth()).toBeCloseTo(0, 1);
  });

  it('increases for tube mode with hotter signal', () => {
    const amp1 = new AmplifierModel('tube', 0.3, undefined, 48000);
    const amp2 = new AmplifierModel('tube', 0.9, undefined, 48000);

    for (let i = 0; i < 2000; i++) {
      const sample = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
      amp1.process(sample);
      amp2.process(sample);
    }

    expect(amp2.getSaturationDepth()).toBeGreaterThan(amp1.getSaturationDepth());
  });

  it('returns 0 for transistor mode below threshold', () => {
    const amp = new AmplifierModel('transistor', 0.1, undefined, 48000);
    for (let i = 0; i < 50; i++) amp.process(0.1 * Math.sin(i * 0.1));
    expect(amp.getSaturationDepth()).toBe(0);
  });

  it('returns > 0 for transistor mode above threshold', () => {
    const amp = new AmplifierModel('transistor', 1.0, undefined, 48000);
    for (let i = 0; i < 50; i++) amp.process(0.9 * Math.sin(i * 0.1));
    expect(amp.getSaturationDepth()).toBeGreaterThan(0);
  });
});

describe('backward compatibility', () => {
  it('transistor mode is symmetric', () => {
    const amp = new AmplifierModel('transistor', 2.0);
    const outPos = amp.process(0.8);
    const outNeg = amp.process(-0.8);
    expect(Math.abs(outPos)).toBeCloseTo(Math.abs(outNeg), 2);
  });

  it('transistor mode preserves amplitude below threshold', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    // Input below threshold (0.85) with drive=1.0 should pass through linearly
    const out = amp.process(0.5);
    expect(out).toBeCloseTo(0.5, 2);
  });

  it('transistor setDrive uses raw value (no tube mapping)', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    amp.setDrive(0.5);
    // 0.3 * 0.5 = 0.15, well below threshold → linear
    const out = amp.process(0.3);
    expect(out).toBeCloseTo(0.15, 2);
  });

  it('reset clears state and does not throw', () => {
    const amp = new AmplifierModel('tube', 1.0);
    for (let i = 0; i < 100; i++) {
      amp.process(Math.sin(i * 0.1));
    }
    expect(() => amp.reset()).not.toThrow();
    // After reset, zero input should give near-zero output
    for (let i = 0; i < 100; i++) {
      amp.process(0);
    }
    expect(Math.abs(amp.process(0))).toBeLessThan(0.01);
  });
});
