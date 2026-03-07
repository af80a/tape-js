import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import { generateSine, generateTwoTone } from './helpers/signals';
import { createProcessor, loadProcessorCtor, renderMono, renderStereo, send, type TestProcessor } from './helpers/worklet-test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

function rms(values: Float32Array, start = 0): number {
  let sumSq = 0;
  let count = 0;
  for (let i = start; i < values.length; i++) {
    sumSq += values[i] * values[i];
    count++;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

describe('TapeProcessor state replay', () => {
  it('keeps dual-mono output sample-identical when decorrelation is disabled', async () => {
    const processor = await createProcessor({
      preset: 'ampex',
      oversample: 4,
      tapeSpeed: 15,
    });

    send(processor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 0 });
    send(processor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
    send(processor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
    send(processor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });

    const input = generateTwoTone(8_192, 48_000, [
      { frequency: 83, amplitude: 0.42 },
      { frequency: 1_700, amplitude: 0.18 },
      { frequency: 6_300, amplitude: 0.08 },
    ]);

    const [left, right] = renderStereo(processor, input, input, {
      params: {
        inputGain: 1.15,
        bias: 0.75,
        drive: 0.55,
        saturation: 0.6,
        ampDrive: 0.45,
        wow: 0,
        flutter: 0,
        hiss: 0,
        color: 0,
        headroom: 18,
        outputGain: 1,
      },
    });

    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it('preserves stage variants and overrides across oversample reinit', async () => {
    const TapeProcessor = await loadProcessorCtor();
    const processor = new TapeProcessor({
      processorOptions: {
        preset: 'studer',
        oversample: 2,
        tapeSpeed: 15,
      },
    }) as TestProcessor;

    send(processor, { type: 'set-stage-variant', stageId: 'recordAmp', value: 'transistor' });
    send(processor, { type: 'set-stage-variant', stageId: 'playbackEQ', value: 'NAB' });
    send(processor, { type: 'set-stage-param', stageId: 'recordAmp', param: 'drive', value: 0.77 });
    send(processor, { type: 'set-stage-param', stageId: 'recordAmp', param: '_trim', value: 6 });
    send(processor, { type: 'set-oversample', value: 4 });

    const channels = processor['channels'] as Array<Record<string, unknown>>;
    const stageVariantOverrides = processor['stageVariantOverrides'] as Map<string, string>;
    const stageGainLin = processor['stageGainLin'] as Map<string, number>;

    expect(processor['oversampleFactor']).toBe(4);
    expect(stageVariantOverrides.get('recordAmp')).toBe('transistor');
    expect(stageVariantOverrides.get('playbackEQ')).toBe('NAB');
    expect((channels[0].recordAmp as { mode: string }).mode).toBe('transistor');
    expect((channels[0].playbackEQ as { standard: string }).standard).toBe('NAB');
    expect((channels[0].recordAmp as { getDrive: () => number }).getDrive()).toBeCloseTo(0.77);
    expect(stageGainLin.get('recordAmp')).toBeCloseTo(Math.pow(10, 6 / 20), 6);
    expect((channels[0].recordOversampler as { factor: number }).factor).toBe(4);
  });

  it('preserves independent amp variants across oversample reinit', async () => {
    const TapeProcessor = await loadProcessorCtor();
    const processor = new TapeProcessor({
      processorOptions: {
        preset: 'mci',
        oversample: 2,
        tapeSpeed: 15,
      },
    }) as TestProcessor;

    send(processor, { type: 'set-stage-variant', stageId: 'recordAmp', value: 'tube' });
    send(processor, { type: 'set-stage-variant', stageId: 'playbackAmp', value: 'transistor' });
    send(processor, { type: 'set-oversample', value: 4 });

    const channels = processor['channels'] as Array<Record<string, unknown>>;

    expect((channels[0].recordAmp as { mode: string }).mode).toBe('tube');
    expect((channels[0].playbackAmp as { mode: string }).mode).toBe('transistor');
    expect((channels[0].recordOversampler as { factor: number }).factor).toBe(4);
  });

  it('updates record coupling mode via runtime message', async () => {
    const TapeProcessor = await loadProcessorCtor();
    const processor = new TapeProcessor({
      processorOptions: {
        preset: 'studer',
        oversample: 2,
        tapeSpeed: 15,
      },
    }) as TestProcessor;

    expect(processor['recordCouplingMode']).toBe('delayed');

    send(processor, { type: 'set-record-coupling-mode', value: 'predictor' });
    expect(processor['recordCouplingMode']).toBe('predictor');

    send(processor, { type: 'set-record-coupling-mode', value: 'bogus' });
    expect(processor['recordCouplingMode']).toBe('delayed');
  });

  it('updates coupling amount via runtime message and clamps invalid values', async () => {
    const TapeProcessor = await loadProcessorCtor();
    const processor = new TapeProcessor({
      processorOptions: {
        preset: 'studer',
        oversample: 2,
        tapeSpeed: 15,
      },
    }) as TestProcessor;

    expect(processor['couplingAmount']).toBe(1);

    send(processor, { type: 'set-coupling-amount', value: 1.35 });
    expect(processor['couplingAmount']).toBeCloseTo(1.35);

    send(processor, { type: 'set-coupling-amount', value: 99 });
    expect(processor['couplingAmount']).toBe(3);

    send(processor, { type: 'set-coupling-amount', value: -1 });
    expect(processor['couplingAmount']).toBe(0.25);
  });

  it('does not let bias act as a standalone audio EQ when the tape core is bypassed', async () => {
    const lowBias = await createProcessor({
      preset: 'ampex',
      oversample: 4,
      tapeSpeed: 15,
    });
    const highBias = await createProcessor({
      preset: 'ampex',
      oversample: 4,
      tapeSpeed: 15,
    });

    const bypassedStages = [
      'inputXfmr',
      'recordAmp',
      'recordEQ',
      'hysteresis',
      'head',
      'transport',
      'noise',
      'playbackEQ',
      'playbackAmp',
      'outputXfmr',
    ] as const;

    for (const processor of [lowBias, highBias]) {
      for (const stageId of bypassedStages) {
        send(processor, { type: 'set-stage-bypass', stageId, value: true });
      }
    }

    const warmup = 4_096;
    const analysis = 8_192;
    const input = new Float32Array(warmup + analysis);
    input.set(generateSine(warmup, 48_000, 10_000, 0.12));
    input.set(generateSine(analysis, 48_000, 10_000, 0.12, 0, warmup), warmup);

    const commonParams = {
      inputGain: 1,
      drive: 0.35,
      saturation: 0.4,
      ampDrive: 0.22,
      wow: 0,
      flutter: 0,
      hiss: 0,
      color: 0,
      headroom: 18,
      outputGain: 1,
    };

    const lowOutput = renderMono(lowBias, input, {
      params: {
        ...commonParams,
        bias: 0.1,
      },
    });
    const highOutput = renderMono(highBias, input, {
      params: {
        ...commonParams,
        bias: 1.0,
      },
    });

    let maxDiff = 0;
    for (let i = warmup; i < input.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(lowOutput[i] - highOutput[i]));
    }

    expect(maxDiff).toBeLessThan(1e-4);
  });

  it('applies preset plugin output trim at the worklet boundary', async () => {
    const studer = await createProcessor({ preset: 'studer', oversample: 4, tapeSpeed: 15 });
    const ampex = await createProcessor({ preset: 'ampex', oversample: 4, tapeSpeed: 15 });

    const bypassedStages = [
      'inputXfmr',
      'recordAmp',
      'recordEQ',
      'bias',
      'hysteresis',
      'head',
      'transport',
      'noise',
      'playbackEQ',
      'playbackAmp',
      'outputXfmr',
    ] as const;

    for (const processor of [studer, ampex]) {
      for (const stageId of bypassedStages) {
        send(processor, { type: 'set-stage-bypass', stageId, value: true });
      }
    }

    const warmup = 4_096;
    const analysis = 8_192;
    const input = new Float32Array(warmup + analysis);
    input.set(generateSine(warmup, 48_000, 1_000, 0.1));
    input.set(generateSine(analysis, 48_000, 1_000, 0.1, 0, warmup), warmup);

    const params = {
      inputGain: 1,
      bias: 0.5,
      drive: 0.5,
      saturation: 0.5,
      ampDrive: 0.5,
      wow: 0,
      flutter: 0,
      hiss: 0,
      color: 0,
      headroom: 18,
      outputGain: 1,
    };

    const studerOut = renderMono(studer, input, { params });
    const ampexOut = renderMono(ampex, input, { params });

    const measuredRatio = rms(studerOut, warmup) / Math.max(rms(ampexOut, warmup), 1e-12);
    const expectedRatio = PRESETS.studer.plugin.outputTrim / PRESETS.ampex.plugin.outputTrim;

    expect(measuredRatio).toBeCloseTo(expectedRatio, 1);
  });

  it('does not use hidden loudness makeup when coupling amount changes', async () => {
    const lowCoupling = await createProcessor({ preset: 'ampex', oversample: 4, tapeSpeed: 15 });
    const highCoupling = await createProcessor({ preset: 'ampex', oversample: 4, tapeSpeed: 15 });

    send(lowCoupling, { type: 'set-coupling-amount', value: 0.25 });
    send(highCoupling, { type: 'set-coupling-amount', value: 3.0 });

    const warmup = 4_096;
    const analysis = 8_192;
    const input = new Float32Array(warmup + analysis);
    input.set(generateSine(warmup, 48_000, 1_000, 0.28));
    input.set(generateSine(analysis, 48_000, 1_000, 0.28, 0, warmup), warmup);

    const params = {
      inputGain: 1,
      bias: 0.75,
      drive: 0.65,
      saturation: 0.7,
      ampDrive: 0.6,
      wow: 0,
      flutter: 0,
      hiss: 0,
      color: 0,
      headroom: 18,
      outputGain: 1,
    };

    const lowOut = renderMono(lowCoupling, input, { params });
    const highOut = renderMono(highCoupling, input, { params });
    const lowRms = rms(lowOut, warmup);
    const highRms = rms(highOut, warmup);
    const levelDeltaDb = Math.abs(20 * Math.log10(highRms / Math.max(lowRms, 1e-12)));

    expect(levelDeltaDb).toBeGreaterThan(0.5);
  });

  it('clamps the returned plugin-domain output after preset trim and output gain', async () => {
    const processor = await createProcessor({ preset: 'mci', oversample: 4, tapeSpeed: 15 });

    const bypassedStages = [
      'inputXfmr',
      'recordAmp',
      'recordEQ',
      'bias',
      'hysteresis',
      'head',
      'transport',
      'noise',
      'playbackEQ',
      'playbackAmp',
      'outputXfmr',
    ] as const;

    for (const stageId of bypassedStages) {
      send(processor, { type: 'set-stage-bypass', stageId, value: true });
    }

    const warmup = 4_096;
    const analysis = 8_192;
    const input = new Float32Array(warmup + analysis);
    input.set(generateSine(warmup, 48_000, 1_000, 1.0));
    input.set(generateSine(analysis, 48_000, 1_000, 1.0, 0, warmup), warmup);

    const output = renderMono(processor, input, {
      params: {
        inputGain: 1,
        bias: 0.5,
        drive: 0.5,
        saturation: 0.5,
        ampDrive: 0.5,
        wow: 0,
        flutter: 0,
        hiss: 0,
        color: 0,
        headroom: 18,
        outputGain: 16,
      },
    });

    let peak = 0;
    for (let i = warmup; i < output.length; i++) {
      peak = Math.max(peak, Math.abs(output[i]));
    }

    expect(peak).toBeLessThanOrEqual(2.0001);
  });
});
