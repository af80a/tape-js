import { describe, it, expect } from 'vitest';
import { HysteresisProcessor } from '../hysteresis';
import { TransportModel } from '../transport';
import { HeadModel } from '../head-model';
import { TransformerModel } from '../transformer';

describe('HysteresisProcessor.setK / setC', () => {
  it('setK changes pinning parameter', () => {
    const hyst = new HysteresisProcessor(48000);
    hyst.setDrive(0.5);
    hyst.setSaturation(0.5);

    // Process with default k
    const results1: number[] = [];
    for (let i = 0; i < 100; i++) {
      results1.push(hyst.process(0.3 * Math.sin(i * 0.1)));
    }

    hyst.reset();
    hyst.setK(0.9); // High pinning

    const results2: number[] = [];
    for (let i = 0; i < 100; i++) {
      results2.push(hyst.process(0.3 * Math.sin(i * 0.1)));
    }

    // Different k should produce different output
    const diff = results1.some((v, i) => Math.abs(v - results2[i]) > 1e-6);
    expect(diff).toBe(true);
  });

  it('setC changes reversibility parameter', () => {
    const hyst = new HysteresisProcessor(48000);
    hyst.setDrive(0.5);
    hyst.setSaturation(0.5);

    const results1: number[] = [];
    for (let i = 0; i < 100; i++) {
      results1.push(hyst.process(0.3 * Math.sin(i * 0.1)));
    }

    hyst.reset();
    hyst.setC(0.8); // High reversibility

    const results2: number[] = [];
    for (let i = 0; i < 100; i++) {
      results2.push(hyst.process(0.3 * Math.sin(i * 0.1)));
    }

    const diff = results1.some((v, i) => Math.abs(v - results2[i]) > 1e-6);
    expect(diff).toBe(true);
  });

  it('setK clamps to valid range', () => {
    const hyst = new HysteresisProcessor(48000);
    hyst.setK(-5); // should clamp to 0.1
    hyst.setK(100); // should clamp to 1.0
    // Should not throw
    const out = hyst.process(0.5);
    expect(isFinite(out)).toBe(true);
  });
});

describe('TransportModel.setWowRate / setFlutterRate', () => {
  it('setWowRate changes modulation frequency', () => {
    // Use two separate instances to avoid shared state issues
    const t1 = new TransportModel(48000);
    t1.setWow(1.0);

    const t2 = new TransportModel(48000);
    t2.setWow(1.0);
    t2.setWowRate(2.5); // Faster wow

    // Prime both delay lines, then compare divergence
    const N = 4800; // 100ms at 48kHz — enough for wow LFO cycles to diverge
    for (let i = 0; i < N; i++) {
      const sample = Math.sin(i * 2 * Math.PI * 440 / 48000);
      t1.process(sample);
      t2.process(sample);
    }

    // After priming, compare next batch
    let maxDiff = 0;
    for (let i = 0; i < N; i++) {
      const sample = Math.sin((N + i) * 2 * Math.PI * 440 / 48000);
      const v1 = t1.process(sample);
      const v2 = t2.process(sample);
      maxDiff = Math.max(maxDiff, Math.abs(v1 - v2));
    }

    expect(maxDiff).toBeGreaterThan(1e-6);
  });

  it('setFlutterRate changes modulation frequency', () => {
    const t1 = new TransportModel(48000);
    t1.setFlutter(1.0);

    const t2 = new TransportModel(48000);
    t2.setFlutter(1.0);
    t2.setFlutterRate(12); // Faster flutter

    const N = 4800;
    for (let i = 0; i < N; i++) {
      const sample = Math.sin(i * 2 * Math.PI * 440 / 48000);
      t1.process(sample);
      t2.process(sample);
    }

    let maxDiff = 0;
    for (let i = 0; i < N; i++) {
      const sample = Math.sin((N + i) * 2 * Math.PI * 440 / 48000);
      const v1 = t1.process(sample);
      const v2 = t2.process(sample);
      maxDiff = Math.max(maxDiff, Math.abs(v1 - v2));
    }

    expect(maxDiff).toBeGreaterThan(1e-6);
  });
});

describe('HeadModel.setBumpGain', () => {
  it('changes head bump gain', () => {
    const head = new HeadModel(48000, 15);

    // Process with default bump gain
    const results1: number[] = [];
    for (let i = 0; i < 1000; i++) {
      results1.push(head.process(Math.sin(i * 0.01))); // Low frequency signal
    }

    head.reset();
    head.setBumpGain(6.0); // Max boost

    const results2: number[] = [];
    for (let i = 0; i < 1000; i++) {
      results2.push(head.process(Math.sin(i * 0.01)));
    }

    const diff = results1.some((v, i) => Math.abs(v - results2[i]) > 1e-6);
    expect(diff).toBe(true);
  });
});

describe('TransformerModel.reconfigure', () => {
  it('changes saturation amount without reconstruction', () => {
    const xfmr = new TransformerModel(48000, { satAmount: 1.0 });

    const results1: number[] = [];
    for (let i = 0; i < 100; i++) {
      results1.push(xfmr.process(0.8 * Math.sin(i * 0.1)));
    }

    xfmr.reset();
    xfmr.reconfigure({ satAmount: 2.0 });

    const results2: number[] = [];
    for (let i = 0; i < 100; i++) {
      results2.push(xfmr.process(0.8 * Math.sin(i * 0.1)));
    }

    const diff = results1.some((v, i) => Math.abs(v - results2[i]) > 1e-6);
    expect(diff).toBe(true);
  });
});
