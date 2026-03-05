import { afterEach, describe, expect, it, vi } from 'vitest';

interface MockProcessorInstance {
  port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
}

type ProcessorCtor = new (options?: { processorOptions?: Record<string, unknown> }) => MockProcessorInstance;

async function loadProcessorCtor(): Promise<ProcessorCtor> {
  vi.resetModules();

  let ctor: ProcessorCtor | null = null;

  class MockAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };
  }

  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
  vi.stubGlobal('registerProcessor', (_name: string, processorCtor: ProcessorCtor) => {
    ctor = processorCtor;
  });

  await import('../tape-processor');

  if (!ctor) {
    throw new Error('Tape processor did not register');
  }

  return ctor;
}

function send(processor: MockProcessorInstance, data: Record<string, unknown>): void {
  processor.port.onmessage?.({ data } as MessageEvent);
}

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
    }) as MockProcessorInstance & Record<string, unknown>;

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
    }) as MockProcessorInstance & Record<string, unknown>;

    send(processor, { type: 'set-stage-variant', stageId: 'recordAmp', value: 'tube' });
    send(processor, { type: 'set-stage-variant', stageId: 'playbackAmp', value: 'transistor' });
    send(processor, { type: 'set-oversample', value: 4 });

    const channels = processor['channels'] as Array<Record<string, unknown>>;

    expect((channels[0].recordAmp as { mode: string }).mode).toBe('tube');
    expect((channels[0].playbackAmp as { mode: string }).mode).toBe('transistor');
    expect((channels[0].recordOversampler as { factor: number }).factor).toBe(4);
  });
});
