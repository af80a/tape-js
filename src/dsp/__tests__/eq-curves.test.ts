import { describe, it, expect } from 'vitest';
import { TapeEQ } from '../eq-curves';

/**
 * Helper: measure the steady-state peak amplitude of a sine wave
 * after passing through a TapeEQ processor.
 */
function measurePeak(eq: TapeEQ, freq: number, sampleRate: number): number {
  const numSamples = 2000;
  let maxOutput = 0;

  for (let i = 0; i < numSamples; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const y = eq.process(x);
    // Skip the first 500 samples to avoid transient
    if (i >= 500) {
      maxOutput = Math.max(maxOutput, Math.abs(y));
    }
  }

  return maxOutput;
}

describe('TapeEQ', () => {
  const sampleRate = 44100;

  describe('NAB record EQ', () => {
    it('boosts HF: 10kHz output > 100Hz output', () => {
      const eq = new TapeEQ(sampleRate, 'NAB', 7.5, 'record');
      const peak100 = measurePeak(eq, 100, sampleRate);

      eq.reset();
      const peak10k = measurePeak(eq, 10000, sampleRate);

      expect(peak10k).toBeGreaterThan(peak100);
    });
  });

  describe('NAB playback EQ', () => {
    it('cuts HF: 10kHz output < 100Hz output', () => {
      const eq = new TapeEQ(sampleRate, 'NAB', 7.5, 'playback');
      const peak100 = measurePeak(eq, 100, sampleRate);

      eq.reset();
      const peak10k = measurePeak(eq, 10000, sampleRate);

      expect(peak10k).toBeLessThan(peak100);
    });
  });

  describe('30 ips mastering EQ', () => {
    it('uses a much flatter low end than 15 ips NAB record EQ', () => {
      const eq30 = new TapeEQ(sampleRate, 'NAB', 30, 'record');
      const low30 = measurePeak(eq30, 50, sampleRate);
      eq30.reset();
      const mid30 = measurePeak(eq30, 1000, sampleRate);

      const eq15 = new TapeEQ(sampleRate, 'NAB', 15, 'record');
      const low15 = measurePeak(eq15, 50, sampleRate);
      eq15.reset();
      const mid15 = measurePeak(eq15, 1000, sampleRate);

      const diff30Db = 20 * Math.log10(mid30 / low30);
      const diff15Db = 20 * Math.log10(mid15 / low15);

      expect(diff30Db).toBeLessThan(6);
      expect(diff15Db).toBeGreaterThan(diff30Db + 10);
    });

    it('keeps NAB and IEC selections equivalent at 30 ips', () => {
      const nab = new TapeEQ(sampleRate, 'NAB', 30, 'playback');
      const iec = new TapeEQ(sampleRate, 'IEC', 30, 'playback');

      const nab12k = measurePeak(nab, 12_000, sampleRate);
      iec.reset();
      const iec12k = measurePeak(iec, 12_000, sampleRate);

      expect(Math.abs(20 * Math.log10(nab12k / iec12k))).toBeLessThan(0.1);
    });

    it('record color remains stable and audible at 30 ips', () => {
      const dark = new TapeEQ(sampleRate, 'NAB', 30, 'record');
      dark.setColor(-1);
      const neutral = new TapeEQ(sampleRate, 'NAB', 30, 'record');
      const bright = new TapeEQ(sampleRate, 'NAB', 30, 'record');
      bright.setColor(1);

      const dark10k = measurePeak(dark, 10_000, sampleRate);
      const neutral10k = measurePeak(neutral, 10_000, sampleRate);
      const bright10k = measurePeak(bright, 10_000, sampleRate);

      expect(Number.isFinite(dark10k)).toBe(true);
      expect(Number.isFinite(bright10k)).toBe(true);
      expect(dark10k).toBeGreaterThan(1e-3);
      expect(bright10k).toBeGreaterThan(1e-3);
      expect(bright10k).toBeGreaterThan(dark10k);
      expect(Math.abs(20 * Math.log10(bright10k / neutral10k))).toBeLessThan(12);
    });
  });

  describe('IEC mode', () => {
    it('produces no NaN for IEC 7.5 ips record', () => {
      const eq = new TapeEQ(sampleRate, 'IEC', 7.5, 'record');

      for (let i = 0; i < 1000; i++) {
        const x = Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
        const y = eq.process(x);
        expect(y).not.toBeNaN();
      }
    });
  });

  describe('first-order shelf slope (6 dB/octave)', () => {
    it('NAB record HF shelf max slope is bounded at ~6.5 dB/octave', () => {
      // A first-order shelf has a THEORETICAL maximum slope of exactly
      // 6 dB/octave (20 dB/decade). We allow 6.5 for numerical margin.
      // Second-order shelves with Q > ~0.5 can exceed this.
      const eq = new TapeEQ(sampleRate, 'NAB', 15, 'record');

      // Measure gain at multiple octave-spaced frequencies
      const freqs = [500, 1000, 2000, 4000, 8000, 16000];
      const gains: number[] = [];
      for (const f of freqs) {
        eq.reset();
        gains.push(measurePeak(eq, f, sampleRate));
      }

      // Check slope between consecutive octaves
      for (let i = 0; i < gains.length - 1; i++) {
        const slopeDb = 20 * Math.log10(gains[i + 1] / gains[i]);
        // First-order: max slope ~6 dB/octave. Allow 6.5 for numerical margin.
        expect(slopeDb).toBeLessThan(6.5);
      }
    });
  });

  describe('first-order time-constant derived gains', () => {
    it('NAB 15ips record: 50 Hz is >15 dB below 1 kHz (first-order LF rolloff from T1=3180µs)', () => {
      // With H(s) = (1+sT1)/(1+sT2), T1=3180µs, T2=50µs, normalized at 1kHz:
      // 50 Hz gain ≈ -22.6 dB. Second-order shelves give only ~-5 dB here.
      const eq = new TapeEQ(sampleRate, 'NAB', 15, 'record');
      const peak50 = measurePeak(eq, 50, sampleRate);
      eq.reset();
      const peak1k = measurePeak(eq, 1000, sampleRate);

      const diffDb = 20 * Math.log10(peak1k / peak50);
      expect(diffDb).toBeGreaterThan(15);
    });

    it('NAB 15ips record: continuous ~6 dB/oct slope from 200 Hz to 1600 Hz', () => {
      // First-order transfer function has a continuous 6 dB/oct slope in
      // the transition region between f1 (50 Hz) and f2 (3183 Hz).
      // Second-order shelves produce a flat plateau between the two shelves.
      const eq = new TapeEQ(sampleRate, 'NAB', 15, 'record');
      const freqs = [200, 400, 800, 1600];
      const peaks: number[] = [];
      for (const f of freqs) {
        eq.reset();
        peaks.push(measurePeak(eq, f, sampleRate));
      }

      for (let i = 0; i < peaks.length - 1; i++) {
        const slopeDb = 20 * Math.log10(peaks[i + 1] / peaks[i]);
        // Each octave should show ~5-7 dB of gain (first-order slope).
        // Second-order shelves give only ~0.5-3 dB/oct in the plateau region.
        expect(slopeDb).toBeGreaterThan(4);
      }
    });
  });

  describe('record + playback complementarity', () => {
    /**
     * Helper: measure gain of record+playback chain at a given frequency.
     * Returns gain in dB relative to unity.
     */
    function measureChainGainDb(standard: 'NAB' | 'IEC', speed: 30 | 15 | 7.5 | 3.75, freq: number): number {
      const recEq = new TapeEQ(sampleRate, standard, speed, 'record');
      const pbEq = new TapeEQ(sampleRate, standard, speed, 'playback');
      const numSamples = 6000;
      let maxOutput = 0;
      for (let i = 0; i < numSamples; i++) {
        const x = Math.sin(2 * Math.PI * freq * i / sampleRate);
        let y = recEq.process(x);
        y = pbEq.process(y);
        if (i >= 3000) maxOutput = Math.max(maxOutput, Math.abs(y));
      }
      return 20 * Math.log10(maxOutput);
    }

    it('NAB record + playback is flat within 0.5 dB across audio band', () => {
      // If the EQ curves are truly complementary (derived from the same
      // time constants), record + playback should produce flat response.
      // This is the key correctness criterion for tape EQ implementation.
      const testFreqs = [100, 500, 1000, 3000, 5000, 8000, 12000];

      for (const freq of testFreqs) {
        const gainDb = measureChainGainDb('NAB', 15, freq);
        expect(Math.abs(gainDb)).toBeLessThan(0.5);
      }
    });

    it('IEC record + playback is flat within 0.5 dB across audio band', () => {
      const testFreqs = [100, 500, 1000, 3000, 5000, 8000, 12000];

      for (const freq of testFreqs) {
        const gainDb = measureChainGainDb('IEC', 15, freq);
        expect(Math.abs(gainDb)).toBeLessThan(0.5);
      }
    });

    it('30 ips record + playback is flat within 0.5 dB across the mastering band', () => {
      const testFreqs = [100, 500, 1000, 3000, 8000, 12000, 16000];

      for (const freq of testFreqs) {
        const gainDb = measureChainGainDb('NAB', 30, freq);
        expect(Math.abs(gainDb)).toBeLessThan(0.5);
      }
    });
  });
});
