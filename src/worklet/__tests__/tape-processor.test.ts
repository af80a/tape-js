import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProcessorCtor, send, type TestProcessor } from './helpers/worklet-test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TapeProcessor state replay', () => {
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
});
