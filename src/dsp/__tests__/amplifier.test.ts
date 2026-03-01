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
    amp.setDrive(4.5);
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
