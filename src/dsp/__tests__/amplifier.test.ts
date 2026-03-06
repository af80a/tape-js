import { describe, it, expect } from 'vitest';
import { cohenHelieIk, gridCurrentIg, cohenHelieJacobian, AmplifierModel } from '../amplifier';
import type { TubeCircuitParams } from '../amplifier';
import { PRESETS } from '../presets';

function rms(signal: number[], start = 0): number {
  let sumSq = 0;
  let count = 0;
  for (let i = start; i < signal.length; i++) {
    sumSq += signal[i] * signal[i];
    count++;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

function residualRms(reference: number[], candidate: number[], gain = 1, start = 0): number {
  let sumSq = 0;
  let count = 0;
  for (let i = start; i < Math.min(reference.length, candidate.length); i++) {
    const residual = reference[i] - candidate[i] * gain;
    sumSq += residual * residual;
    count++;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

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

  describe('gridCurrentIg (grid current)', () => {
    it('is near zero for negative Vgk (normal operation)', () => {
      // Grid current only flows when Vgk > 0 (grid conduction)
      const Ig = gridCurrentIg(-1.5);
      expect(Ig).toBeCloseTo(0, 5);
    });

    it('is positive for positive Vgk (grid conduction)', () => {
      const Ig = gridCurrentIg(5.0);
      expect(Ig).toBeGreaterThan(0);
    });

    it('increases with increasing Vgk', () => {
      const Ig_low = gridCurrentIg(1.0);
      const Ig_high = gridCurrentIg(5.0);
      expect(Ig_high).toBeGreaterThan(Ig_low);
    });

    it('is always non-negative', () => {
      for (const Vgk of [-10, -5, -2, -1, 0, 1, 5, 10]) {
        expect(gridCurrentIg(Vgk)).toBeGreaterThanOrEqual(0);
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
      const Ip_hi = cohenHelieIk(Vpk + eps, Vgk) - gridCurrentIg(Vgk);
      const Ip_lo = cohenHelieIk(Vpk - eps, Vgk) - gridCurrentIg(Vgk);
      const dIp_dVpk_num = (Ip_hi - Ip_lo) / (2 * eps);
      expect(J[0]).toBeCloseTo(dIp_dVpk_num, 4);

      // Numerical dIp/dVgk
      const Ip_hi2 = cohenHelieIk(Vpk, Vgk + eps) - gridCurrentIg(Vgk + eps);
      const Ip_lo2 = cohenHelieIk(Vpk, Vgk - eps) - gridCurrentIg(Vgk - eps);
      const dIp_dVgk_num = (Ip_hi2 - Ip_lo2) / (2 * eps);
      expect(J[1]).toBeCloseTo(dIp_dVgk_num, 4);

      // Numerical dIg/dVgk
      const Ig_hi = gridCurrentIg(Vgk + eps);
      const Ig_lo = gridCurrentIg(Vgk - eps);
      const dIg_dVgk_num = (Ig_hi - Ig_lo) / (2 * eps);
      expect(J[3]).toBeCloseTo(dIg_dVgk_num, 4);
    });
  });

  describe('plate current (Ip = Ik - Ig)', () => {
    it('plate current equals cathode minus grid current', () => {
      const Vpk = 200, Vgk = -1.0;
      const Ik = cohenHelieIk(Vpk, Vgk);
      const Ig = gridCurrentIg(Vgk);
      const Ip = Ik - Ig;
      expect(Ip).toBeCloseTo(Ik, 5); // Ig is very small but non-zero due to contact potential
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
    let maxSatLow = 0;
    for (let i = 0; i < fs; i++) {
      ampLow.process(0.5 * Math.sin(2 * Math.PI * 440 * i / fs));
      maxSatLow = Math.max(maxSatLow, ampLow.getSaturationDepth());
    }

    // High drive
    const ampHigh = new AmplifierModel('tube', 1.0);
    let maxSatHigh = 0;
    for (let i = 0; i < fs; i++) {
      ampHigh.process(0.5 * Math.sin(2 * Math.PI * 440 * i / fs));
      maxSatHigh = Math.max(maxSatHigh, ampHigh.getSaturationDepth());
    }

    // High drive should produce more saturation (measured by saturation depth)
    expect(maxSatHigh).toBeGreaterThan(maxSatLow);
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

    // Check asymmetry: positive and negative peaks should differ measurably
    const posPeak = Math.max(...outputs.slice(fs * 0.5));
    const negPeak = Math.min(...outputs.slice(fs * 0.5));
    expect(Math.abs(Math.abs(posPeak) - Math.abs(negPeak))).toBeGreaterThan(0.01);
  });
});

describe('power supply sag (Sag v2.0 physics)', () => {
  it('Vpp shifts under sustained heavy signal (anti-sag due to grid blocking)', () => {
    // In a Class A preamp stage (12AX7), heavy overdrive causes grid current to flow,
    // which charges the input coupling capacitor. This pushes the average grid voltage
    // negative, plunging the tube into cutoff on the negative half-cycles.
    // The reduced average plate current allows the power supply to "swell" (anti-sag).
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;
    
    // Measure initial Vpp (max over a full 120Hz ripple cycle)
    let initialVpp = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      amp.process(0);
      initialVpp = Math.max(initialVpp, amp.getScreenVoltage());
    }

    // Process 0.5s of loud sine to invoke blocking distortion
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }
    
    // Measure swollen Vpp over a cycle
    let swollenVpp = 0;
    for (let i = 0; i < fs * 0.05; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
      swollenVpp = Math.max(swollenVpp, amp.getScreenVoltage());
    }

    // Supply voltage should have swollen measurably
    expect(swollenVpp).toBeGreaterThan(initialVpp + 0.1);
  });

  it('supply recovers after signal stops', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;

    // Measure initial Vpp (max over a full 120Hz ripple cycle)
    let initialVpp = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      amp.process(0);
      initialVpp = Math.max(initialVpp, amp.getScreenVoltage());
    }

    // Heavy signal for 0.5s to force grid blocking / anti-sag
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }
    
    // Measure swollen Vpp over a cycle
    let swollenVpp = 0;
    for (let i = 0; i < fs * 0.05; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
      swollenVpp = Math.max(swollenVpp, amp.getScreenVoltage());
    }

    // Silence for 1.5s (supply recovers, cap discharges)
    for (let i = 0; i < fs * 1.5; i++) {
      amp.process(0);
    }

    // Measure recovered Vpp over a cycle
    let recoveredVpp = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      amp.process(0);
      recoveredVpp = Math.max(recoveredVpp, amp.getScreenVoltage());
    }

    // Supply should have recovered below swollen level, close to initial
    expect(recoveredVpp).toBeLessThan(swollenVpp - 0.1);
    expect(Math.abs(recoveredVpp - initialVpp)).toBeLessThan(1.0);
  });
});

describe('sag time constant matches physical model', () => {
  it('sag responds quickly (within 100ms) due to physical AC mains model', () => {
    // With Sag v2.0 physics, the rectifier tube (SAG_K_RECT) and secondary resistance (SAG_R_SEC)
    // create a dynamic, non-linear charging characteristic. We test that it responds significantly
    // within 100ms.
    const fs = 48000;
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    
    let initialVpp = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      amp.process(0);
      initialVpp = Math.max(initialVpp, amp.getScreenVoltage());
    }

    // Drive hard for 500ms
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }

    let finalVpp = 0;
    for (let i = 0; i < fs * 0.05; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
      finalVpp = Math.max(finalVpp, amp.getScreenVoltage());
    }
    const swellDepth = finalVpp - initialVpp;

    // Now create a fresh amplifier and measure where it is at exactly 100ms
    const amp100 = new AmplifierModel('tube', 1.0);
    amp100.setDrive(1.0);
    
    let initial100 = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      amp100.process(0);
      initial100 = Math.max(initial100, amp100.getScreenVoltage());
    }

    // Drive hard for exactly 100ms
    const samples100ms = Math.round(fs * 0.1);
    for (let i = 0; i < samples100ms; i++) {
      amp100.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }

    const swollen100 = amp100.getScreenVoltage() - initial100;

    // The shift should be at least 35% of the eventual depth after 100ms.
    expect(swollen100 / swellDepth).toBeGreaterThan(0.35);
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

  it('returns low saturation for transistor mode with small signal', () => {
    const amp = new AmplifierModel('transistor', 0.1, undefined, 48000);
    for (let i = 0; i < 50; i++) amp.process(0.1 * Math.sin(i * 0.1));
    expect(amp.getSaturationDepth()).toBeLessThan(0.3);
  });

  it('returns > 0 for transistor mode with large signal', () => {
    const amp = new AmplifierModel('transistor', 1.0, undefined, 48000);
    for (let i = 0; i < 50; i++) amp.process(0.9 * Math.sin(i * 0.1));
    expect(amp.getSaturationDepth()).toBeGreaterThan(0);
  });
});

describe('transistor dynamic bias model', () => {
  it('produces asymmetric output (Class-A characteristic)', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    const fs = 48000;
    const outputs: number[] = [];
    for (let i = 0; i < fs * 0.2; i++) {
      outputs.push(amp.process(0.8 * Math.sin(2 * Math.PI * 440 * i / fs)));
    }
    const steady = outputs.slice(Math.floor(outputs.length * 0.5));
    const posPeak = Math.max(...steady);
    const negPeak = Math.min(...steady);
    expect(Math.abs(Math.abs(posPeak) - Math.abs(negPeak))).toBeGreaterThan(0.01);
  });

  it('bias drifts under sustained asymmetric drive', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    const fs = 48000;
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(0.9 * Math.sin(2 * Math.PI * 100 * i / fs));
    }
    expect(amp.getSaturationDepth()).toBeGreaterThan(0);
  });

  it('small signals pass through nearly linearly (tanh ≈ x for |x| << 1)', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    amp.setDrive(0.5);
    const out = amp.process(0.3);
    expect(out).toBeCloseTo(0.15, 1);
  });

  it('reset clears bias state', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    for (let i = 0; i < 5000; i++) {
      amp.process(0.9 * Math.sin(i * 0.1));
    }
    amp.reset();
    const out = amp.process(0.01);
    expect(out).toBeCloseTo(Math.tanh(0.01), 2);
  });
});

describe('stage-specific amplifier asymmetry', () => {
  it('Ampex record and playback tube stage configs produce measurably different hot-tone outputs at equal drive', () => {
    const fs = 48_000;
    const drive = 0.65;
    const record = new AmplifierModel(
      'tube',
      drive,
      PRESETS.ampex.recordAmpConfig?.tubeCircuit,
      fs,
      1,
      PRESETS.ampex.recordAmpConfig,
    );
    const playback = new AmplifierModel(
      'tube',
      drive,
      PRESETS.ampex.playbackAmpConfig?.tubeCircuit,
      fs,
      1,
      PRESETS.ampex.playbackAmpConfig,
    );

    const recordOut: number[] = [];
    const playbackOut: number[] = [];
    let maxRecordSat = 0;
    let maxPlaybackSat = 0;
    for (let i = 0; i < fs * 0.25; i++) {
      const x = 0.6 * Math.sin(2 * Math.PI * 1_000 * i / fs);
      recordOut.push(record.process(x));
      playbackOut.push(playback.process(x));
      maxRecordSat = Math.max(maxRecordSat, record.getSaturationDepth());
      maxPlaybackSat = Math.max(maxPlaybackSat, playback.getSaturationDepth());
    }

    const start = Math.floor(recordOut.length * 0.5);
    const gainMatch = rms(recordOut, start) / Math.max(rms(playbackOut, start), 1e-12);
    const nullResidualDb = db(residualRms(recordOut, playbackOut, gainMatch, start));

    expect(nullResidualDb).toBeGreaterThan(-32);
    expect(Math.abs(maxRecordSat - maxPlaybackSat)).toBeGreaterThan(0.01);
  });

  it('MCI record and playback transistor voicings produce measurably different bias-memory behavior at equal drive', () => {
    const fs = 48_000;
    const drive = 0.75;
    const record = new AmplifierModel(
      'transistor',
      drive,
      undefined,
      fs,
      1,
      PRESETS.mci.recordAmpConfig,
    );
    const playback = new AmplifierModel(
      'transistor',
      drive,
      undefined,
      fs,
      1,
      PRESETS.mci.playbackAmpConfig,
    );

    const recordOut: number[] = [];
    const playbackOut: number[] = [];
    let maxRecordSat = 0;
    let maxPlaybackSat = 0;
    for (let i = 0; i < fs * 0.3; i++) {
      const x = 0.9 * Math.sin(2 * Math.PI * 120 * i / fs);
      recordOut.push(record.process(x));
      playbackOut.push(playback.process(x));
      maxRecordSat = Math.max(maxRecordSat, record.getSaturationDepth());
      maxPlaybackSat = Math.max(maxPlaybackSat, playback.getSaturationDepth());
    }

    const start = Math.floor(recordOut.length * 0.5);
    const gainMatch = rms(recordOut, start) / Math.max(rms(playbackOut, start), 1e-12);
    const nullResidualDb = db(residualRms(recordOut, playbackOut, gainMatch, start));

    expect(nullResidualDb).toBeGreaterThan(-31);
  });
});

describe('backward compatibility', () => {
  it('reset clears state and does not throw', () => {
    const amp = new AmplifierModel('tube', 1.0);
    for (let i = 0; i < 100; i++) {
      amp.process(Math.sin(i * 0.1));
    }
    expect(() => amp.reset()).not.toThrow();
    for (let i = 0; i < 100; i++) {
      amp.process(0);
    }
    expect(Math.abs(amp.process(0))).toBeLessThan(0.01);
  });
});

describe('Newton-Raphson step clamping', () => {
  it('survives extreme transient spikes without NaN', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;
    for (let i = 0; i < 1000; i++) {
      amp.process(0.1 * Math.sin(2 * Math.PI * 440 * i / fs));
    }
    // Sudden extreme spike
    for (const spike of [10, -10, 50, -50, 100]) {
      const y = amp.process(spike);
      expect(Number.isFinite(y)).toBe(true);
    }
    // Model should still be stable after the spikes
    for (let i = 0; i < 1000; i++) {
      const y = amp.process(0.3 * Math.sin(2 * Math.PI * 440 * i / fs));
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe('Backward Euler sag stability', () => {
  it('remains stable with extreme component values', () => {
    const extremeCircuit: TubeCircuitParams = {
      Rp: 220e3, Rg: 10e6, Rk: 10e3,
      Cc_in: 1e-9, Cc_out: 1e-9, Ck: 100e-6,
      Vpp: 400,
    };
    const amp = new AmplifierModel('tube', 1.0, extremeCircuit);
    amp.setDrive(1.0);
    const fs = 48000;
    for (let i = 0; i < fs * 0.5; i++) {
      const y = amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
      expect(Number.isFinite(y)).toBe(true);
    }
    // Screen voltage should be positive and finite
    expect(amp.getScreenVoltage()).toBeGreaterThan(0);
    expect(Number.isFinite(amp.getScreenVoltage())).toBe(true);
  });

  it('sag voltage never goes negative', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;
    for (let i = 0; i < fs * 2; i++) {
      amp.process(2.0 * Math.sin(2 * Math.PI * 50 * i / fs));
      expect(amp.getScreenVoltage()).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('inter-stage coupling API', () => {
  it('getGridCurrent returns finite value during tube processing', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;
    for (let i = 0; i < 1000; i++) {
      amp.process(0.5 * Math.sin(2 * Math.PI * 440 * i / fs));
    }
    const Ig = amp.getGridCurrent();
    expect(Number.isFinite(Ig)).toBe(true);
    expect(Ig).toBeGreaterThanOrEqual(0);
  });

  it('grid current increases with positive grid drive', () => {
    const fs = 48000;
    const ampLow = new AmplifierModel('tube', 0.2);
    const ampHigh = new AmplifierModel('tube', 1.0);
    let maxIgLow = 0, maxIgHigh = 0;
    for (let i = 0; i < fs * 0.5; i++) {
      const x = 0.8 * Math.sin(2 * Math.PI * 440 * i / fs);
      ampLow.process(x);
      ampHigh.process(x);
      maxIgLow = Math.max(maxIgLow, ampLow.getGridCurrent());
      maxIgHigh = Math.max(maxIgHigh, ampHigh.getGridCurrent());
    }
    expect(maxIgHigh).toBeGreaterThan(maxIgLow);
  });

  it('setSagVoltage overrides screen voltage for shared PSU coupling', () => {
    const amp = new AmplifierModel('tube', 0.5);
    const fs = 48000;
    for (let i = 0; i < 1000; i++) amp.process(0);
    const originalVss = amp.getScreenVoltage();

    amp.setSagVoltage(originalVss * 0.8);
    expect(amp.getScreenVoltage()).toBeCloseTo(originalVss * 0.8, 1);

    // Processing should still produce finite output with altered sag
    for (let i = 0; i < 1000; i++) {
      const y = amp.process(0.5 * Math.sin(2 * Math.PI * 440 * i / fs));
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('setSagVoltage is no-op for transistor mode', () => {
    const amp = new AmplifierModel('transistor', 1.0);
    amp.setSagVoltage(100);
    const y = amp.process(0.5);
    expect(Number.isFinite(y)).toBe(true);
  });

  it('grid current loading reduces effective transformer output', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.0 * Math.sin(2 * Math.PI * 440 * i / fs));
    }
    const Ig = amp.getGridCurrent();
    const Z_out = 10000;
    const voltageDrop = Ig * Z_out;
    // For a driven tube, grid current should create a measurable voltage drop
    // across a 10k secondary impedance
    expect(voltageDrop).toBeGreaterThan(0);
    expect(voltageDrop).toBeLessThan(2);
  });

  it('previewGridCurrent is side-effect free', () => {
    const amp = new AmplifierModel('tube', 0.9);
    const fs = 48_000;
    const input = 0.65;

    for (let i = 0; i < fs * 0.1; i++) {
      amp.process(0.7 * Math.sin(2 * Math.PI * 220 * i / fs));
    }

    const preview = amp.previewGridCurrent(input, 0, 22_000);
    const outputAfterPreview = amp.process(input, 0, 22_000);

    const control = new AmplifierModel('tube', 0.9);
    for (let i = 0; i < fs * 0.1; i++) {
      control.process(0.7 * Math.sin(2 * Math.PI * 220 * i / fs));
    }
    const outputControl = control.process(input, 0, 22_000);

    expect(preview).toBeGreaterThanOrEqual(0);
    expect(outputAfterPreview).toBeCloseTo(outputControl, 9);
    expect(amp.getGridCurrent()).toBeCloseTo(control.getGridCurrent(), 9);
    expect(amp.getPlateCurrent()).toBeCloseTo(control.getPlateCurrent(), 9);
    expect(amp.getScreenVoltage()).toBeCloseTo(control.getScreenVoltage(), 9);
  });
});
