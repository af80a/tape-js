import { describe, it, expect } from 'vitest';
import { TransportModel } from '../transport';
import { PRESETS } from '../presets';

/**
 * Evidence notes:
 * - Hard limits are based on published wow/flutter envelopes for professional decks.
 * - Tests intentionally avoid waveform snapshots; they check bounded deviation,
 *   stochastic structure, and whether preset defaults stay inside documented ranges.
 */

describe('TransportModel', () => {
  const fs = 44100;

  function measureToneResidualRms(
    model: TransportModel,
    carrierHz: number,
    durationSec = 2,
    skipSec = 0.5,
  ): number {
    const totalSamples = Math.floor(fs * durationSec);
    const start = Math.floor(fs * skipSec);
    const output = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      output[i] = model.process(Math.sin((2 * Math.PI * carrierHz * i) / fs));
    }

    let sinProj = 0;
    let cosProj = 0;
    for (let i = start; i < totalSamples; i++) {
      const phase = (2 * Math.PI * carrierHz * i) / fs;
      sinProj += output[i] * Math.sin(phase);
      cosProj += output[i] * Math.cos(phase);
    }

    const count = Math.max(1, totalSamples - start);
    const sinGain = (2 * sinProj) / count;
    const cosGain = (2 * cosProj) / count;

    let sumSq = 0;
    for (let i = start; i < totalSamples; i++) {
      const phase = (2 * Math.PI * carrierHz * i) / fs;
      const fitted = sinGain * Math.sin(phase) + cosGain * Math.cos(phase);
      const residual = output[i] - fitted;
      sumSq += residual * residual;
    }

    return Math.sqrt(sumSq / count);
  }

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

  it('stereo channels diverge when wow/flutter are active', () => {
    const ch0 = new TransportModel(fs, 0);
    const ch1 = new TransportModel(fs, 1);

    ch0.setWow(0.5);
    ch0.setFlutter(0.5);
    ch1.setWow(0.5);
    ch1.setFlutter(0.5);

    let maxDiff = 0;
    const numSamples = fs; // 1 second
    for (let i = 0; i < numSamples; i++) {
      const x = Math.sin((2 * Math.PI * 440 * i) / fs);
      const y0 = ch0.process(x);
      const y1 = ch1.process(x);
      maxDiff = Math.max(maxDiff, Math.abs(y0 - y1));
    }

    // With different phase offsets, outputs should diverge measurably
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('default channelIndex=0 is backward compatible', () => {
    const transport = new TransportModel(fs);
    transport.setWow(0.3);
    transport.setFlutter(0.3);

    const numSamples = fs;
    for (let i = 0; i < numSamples; i++) {
      const x = Math.sin((2 * Math.PI * 440 * i) / fs);
      const y = transport.process(x);
      expect(y).not.toBeNaN();
      expect(Math.abs(y)).toBeLessThan(3);
    }
  });

  describe('noise-based modulation (non-periodic wow/flutter)', () => {
    it('wow modulation is not perfectly periodic over 5 seconds', () => {
      // With noise-based wow, the modulation should vary from cycle to cycle.
      // Process 5 seconds and check that the delay modulation pattern is
      // not purely periodic by comparing output at two points separated by
      // one complete wow cycle.
      const transport = new TransportModel(fs);
      transport.setWow(0.5);
      transport.setFlutter(0);

      // Process 5 seconds of ramp signal. A ramp makes the output directly
      // reflect the delay: cubic Lagrange interpolation of a linear function
      // is exact, so output(n) ≈ (n - delay(n)) / fs. With periodic delay,
      // consecutive-cycle diffs are identical; with noise, they diverge.
      const outputs: number[] = [];
      for (let i = 0; i < fs * 5; i++) {
        outputs.push(transport.process(i / fs));
      }

      // The wow period is ~1/1.2 Hz ≈ 0.833 seconds ≈ 36750 samples at 44.1kHz
      const wowPeriodSamples = Math.round(fs / 1.2);

      // Compare output between consecutive wow cycles at multiple points
      // With noise modulation, not all cycle-to-cycle differences will be identical
      let totalVariation = 0;
      const checkStart = fs * 2; // skip transient
      const numChecks = 10;
      for (let j = 0; j < numChecks; j++) {
        const idx = checkStart + j * Math.floor(wowPeriodSamples / numChecks);
        const diff1 = outputs[idx] - outputs[idx + wowPeriodSamples];
        const diff2 = outputs[idx + wowPeriodSamples] - outputs[idx + 2 * wowPeriodSamples];
        // If modulation is purely periodic, diff1 ≈ diff2 exactly
        totalVariation += Math.abs(diff1 - diff2);
      }

      // Non-periodic modulation should show some variation between cycles
      expect(totalVariation).toBeGreaterThan(1e-6);
    });

    it('flutter has non-periodic variation', () => {
      const transport = new TransportModel(fs);
      transport.setWow(0);
      transport.setFlutter(0.5);

      const outputs: number[] = [];
      for (let i = 0; i < fs * 3; i++) {
        outputs.push(transport.process(i / fs));
      }

      // Flutter period ~1/6.5 Hz ≈ 6785 samples
      const flutterPeriodSamples = Math.round(fs / 6.5);

      let totalVariation = 0;
      const checkStart = fs;
      for (let j = 0; j < 10; j++) {
        const idx = checkStart + j * Math.floor(flutterPeriodSamples / 10);
        const diff1 = outputs[idx] - outputs[idx + flutterPeriodSamples];
        const diff2 = outputs[idx + flutterPeriodSamples] - outputs[idx + 2 * flutterPeriodSamples];
        totalVariation += Math.abs(diff1 - diff2);
      }

      expect(totalVariation).toBeGreaterThan(1e-6);
    });

    it('scrape flutter adds high-frequency micro-modulation', () => {
      // Scrape flutter (50-500 Hz range) from guide rollers adds subtle
      // high-frequency pitch instability. Test by measuring the spectral
      // content of the output modulation in the scrape flutter band.
      const transport = new TransportModel(fs);
      transport.setWow(0);
      transport.setFlutter(0.5);

      // Process a ramp to measure delay modulation directly
      const outputs: number[] = [];
      for (let i = 0; i < fs * 2; i++) {
        outputs.push(transport.process(i / fs));
      }

      // Compute the "delay signal" (output deviation from perfect ramp)
      // which reveals the modulation pattern
      const modulation: number[] = [];
      const startIdx = Math.floor(fs * 0.5); // skip transient
      for (let i = startIdx; i < outputs.length - 1; i++) {
        // Instantaneous frequency deviation: derivative of output minus expected
        modulation.push(outputs[i + 1] - outputs[i] - 1 / fs);
      }

      // Measure high-frequency energy in the modulation (scrape flutter band)
      // Use a simple high-pass: difference filter to isolate fast fluctuations
      let hfEnergy = 0;
      for (let i = 1; i < modulation.length; i++) {
        const diff = modulation[i] - modulation[i - 1];
        hfEnergy += diff * diff;
      }
      hfEnergy /= modulation.length;

      // With scrape flutter, the HF energy should be non-negligible
      expect(hfEnergy).toBeGreaterThan(1e-18);
    });

    it('wow frequency drifts over time (simulating reel diameter change)', () => {
      // Real wow frequency varies as tape moves between reels (changing diameter).
      // Test: compare the wow modulation period at second 3-6 vs second 12-15
      // using zero-crossing count of the delay modulation signal.
      const transport = new TransportModel(fs);
      transport.setWow(0.5);
      transport.setFlutter(0);

      const duration = 16; // seconds
      const outputs: number[] = [];
      for (let i = 0; i < fs * duration; i++) {
        outputs.push(transport.process(i / fs));
      }

      // Extract the delay modulation: output - ideal_ramp
      function countZeroCrossings(start: number, windowLen: number): number {
        let crossings = 0;
        // Remove DC from mod signal by subtracting running mean
        const mod: number[] = [];
        for (let i = start; i < start + windowLen; i++) {
          mod.push(outputs[i] - i / fs);
        }
        // Remove DC (mean)
        let mean = 0;
        for (const v of mod) mean += v;
        mean /= mod.length;
        for (let i = 0; i < mod.length; i++) mod[i] -= mean;

        for (let i = 1; i < mod.length; i++) {
          if ((mod[i - 1] < 0 && mod[i] >= 0) || (mod[i - 1] >= 0 && mod[i] < 0)) {
            crossings++;
          }
        }
        return crossings;
      }

      const windowLen = fs * 3;
      const earlyCrossings = countZeroCrossings(fs * 3, windowLen);
      const lateCrossings = countZeroCrossings(fs * 12, windowLen);

      // Both should have crossings (wow is active)
      expect(earlyCrossings).toBeGreaterThan(2);
      expect(lateCrossings).toBeGreaterThan(2);

      // With drift, the crossing counts should differ
      // (different effective wow frequency at different times)
      expect(earlyCrossings).not.toBe(lateCrossings);
    });

  });

  describe('speed deviation calibration', () => {
    /**
     * Measure peak speed deviation by tracking instantaneous frequency
     * of a sine carrier through zero-crossing analysis.
     */
    function measurePeakDeviation(
      model: TransportModel,
      durationSec: number,
      carrierFreq = 1000,
      skipSec = 0.5,
    ): number {
      const duration = Math.ceil(fs * durationSec);
      const TWO_PI = 2 * Math.PI;

      // Collect interpolated positive zero crossings
      const zeros: number[] = [];
      let prev = 0;
      for (let i = 0; i < duration; i++) {
        const x = Math.sin(TWO_PI * carrierFreq * i / fs);
        const y = model.process(x);
        if (prev <= 0 && y > 0 && i > 0) {
          // Linear interpolation for sub-sample accuracy
          const frac = -prev / (y - prev);
          zeros.push(i - 1 + frac);
        }
        prev = y;
      }

      // Measure speed deviation using N-period averaging for noise reduction
      const N = 5;
      const nominalPeriod = fs / carrierFreq;
      let maxDev = 0;
      for (let i = N; i < zeros.length; i++) {
        if (zeros[i - N] < fs * skipSec) continue;
        const measuredPeriod = (zeros[i] - zeros[i - N]) / N;
        const deviation = Math.abs(measuredPeriod - nominalPeriod) / nominalPeriod;
        maxDev = Math.max(maxDev, deviation);
      }
      return maxDev;
    }

    it('wow at depth=1.0 produces ≤ 0.5% peak speed deviation', () => {
      const model = new TransportModel(fs);
      model.setWow(1.0);
      model.setFlutter(0);

      // 3 seconds covers >3 wow cycles at 1.2 Hz
      const peakDev = measurePeakDeviation(model, 3);
      expect(peakDev).toBeLessThan(0.006); // 0.5% + measurement margin
    });

    it('flutter at depth=1.0 produces ≤ 0.2% peak speed deviation', () => {
      const model = new TransportModel(fs);
      model.setWow(0);
      model.setFlutter(1.0);

      const peakDev = measurePeakDeviation(model, 1.5);
      expect(peakDev).toBeLessThan(0.003); // 0.2% + measurement margin
    });

    it('Studer defaults stay within the published pro-machine wow/flutter envelope', () => {
      const model = new TransportModel(fs, 0, PRESETS.studer.transportProfile);
      model.setWow(PRESETS.studer.defaults.wow);
      model.setFlutter(PRESETS.studer.defaults.flutter);

      // Studer A810 brochures/spec sheets quote max wow/flutter around 0.04-0.05%
      // at 15 ips (NAB/DIN weighted depending publication). The model is unweighted,
      // so allow a small margin above the published weighted number.
      const peakDev = measurePeakDeviation(model, 3);
      expect(peakDev).toBeLessThan(0.001);
    });

    it('Ampex defaults stay within the published ATR-102 wow/flutter envelope', () => {
      const model = new TransportModel(fs, 0, PRESETS.ampex.transportProfile);
      model.setWow(PRESETS.ampex.defaults.wow);
      model.setFlutter(PRESETS.ampex.defaults.flutter);

      // ATR-102 literature and derivative emulations consistently describe the
      // deck as an ultra-stable mastering machine around 0.04% weighted at 15 ips.
      const peakDev = measurePeakDeviation(model, 3);
      expect(peakDev).toBeLessThan(0.0008);
    });

    it('MCI defaults stay within the published JH-24 wow/flutter envelope', () => {
      const model = new TransportModel(fs, 0, PRESETS.mci.transportProfile);
      model.setWow(PRESETS.mci.defaults.wow);
      model.setFlutter(PRESETS.mci.defaults.flutter);

      // Historical JH-24 spec sheets quote roughly 0.04% weighted wow/flutter.
      // The model is intentionally slightly conservative on the unweighted side.
      const peakDev = measurePeakDeviation(model, 3);
      expect(peakDev).toBeLessThan(0.0008);
    });

    it('still produces valid output with noise modulation', () => {
      const transport = new TransportModel(fs);
      transport.setWow(1.0);
      transport.setFlutter(1.0);

      for (let i = 0; i < fs * 2; i++) {
        const x = Math.sin(2 * Math.PI * 440 * i / fs);
        const y = transport.process(x);
        expect(Number.isFinite(y)).toBe(true);
        expect(Math.abs(y)).toBeLessThan(3);
      }
    });

    it('machine transport profiles produce measurably different flutter residuals at the same control setting', () => {
      const ampex = new TransportModel(fs, 0, PRESETS.ampex.transportProfile);
      const mci = new TransportModel(fs, 0, PRESETS.mci.transportProfile);
      ampex.setWow(0);
      ampex.setFlutter(0.5);
      mci.setWow(0);
      mci.setFlutter(0.5);

      const ampexResidual = measureToneResidualRms(ampex, 10_000);
      const mciResidual = measureToneResidualRms(mci, 10_000);

      expect(Math.max(mciResidual, ampexResidual)).toBeGreaterThan(
        Math.min(mciResidual, ampexResidual) * 1.15,
      );
    });
  });
});
