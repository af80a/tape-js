import { vi } from 'vitest';

export interface MockProcessorInstance {
  port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
}

export interface TestProcessor extends MockProcessorInstance {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
  [key: string]: unknown;
}

export type ProcessorCtor = new (options?: { processorOptions?: Record<string, unknown> }) => TestProcessor;

export interface WorkletParamValues {
  inputGain: number;
  bias: number;
  drive: number;
  saturation: number;
  ampDrive: number;
  wow: number;
  flutter: number;
  hiss: number;
  color: number;
  headroom: number;
  outputGain: number;
}

export interface RenderProbe {
  blockIndex: number;
  offset: number;
  outputBlock: Float32Array;
}

export interface RenderOptions {
  params?: Partial<WorkletParamValues>;
  blockSize?: number;
  probe?: (processor: TestProcessor, probe: RenderProbe) => void;
}

const DEFAULT_PARAMS: WorkletParamValues = {
  inputGain: 1.0,
  bias: 0.5,
  drive: 0.5,
  saturation: 0.5,
  ampDrive: 0.5,
  wow: 0.15,
  flutter: 0.1,
  hiss: 0.05,
  color: 0,
  headroom: 18,
  outputGain: 1.0,
};

export async function loadProcessorCtor(sampleRateHz = 48_000): Promise<ProcessorCtor> {
  vi.resetModules();

  let ctor: ProcessorCtor | null = null;

  class MockAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };
  }

  vi.stubGlobal('sampleRate', sampleRateHz);
  vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
  vi.stubGlobal('registerProcessor', (_name: string, processorCtor: ProcessorCtor) => {
    ctor = processorCtor;
  });

  await import('../../tape-processor');

  if (!ctor) {
    throw new Error('Tape processor did not register');
  }

  return ctor;
}

export async function createProcessor(
  processorOptions: Record<string, unknown> = {},
  sampleRateHz = 48_000,
): Promise<TestProcessor> {
  const TapeProcessor = await loadProcessorCtor(sampleRateHz);
  return new TapeProcessor({ processorOptions }) as TestProcessor;
}

export function send(processor: MockProcessorInstance, data: Record<string, unknown>): void {
  processor.port.onmessage?.({ data } as MessageEvent);
}

export function createKRateParameters(
  overrides: Partial<WorkletParamValues> = {},
): Record<string, Float32Array> {
  const values = { ...DEFAULT_PARAMS, ...overrides };
  return {
    inputGain: new Float32Array([values.inputGain]),
    bias: new Float32Array([values.bias]),
    drive: new Float32Array([values.drive]),
    saturation: new Float32Array([values.saturation]),
    ampDrive: new Float32Array([values.ampDrive]),
    wow: new Float32Array([values.wow]),
    flutter: new Float32Array([values.flutter]),
    hiss: new Float32Array([values.hiss]),
    color: new Float32Array([values.color]),
    headroom: new Float32Array([values.headroom]),
    outputGain: new Float32Array([values.outputGain]),
  };
}

export function renderMono(
  processor: TestProcessor,
  input: Float32Array,
  options: RenderOptions = {},
): Float32Array {
  const blockSize = options.blockSize ?? 128;
  const parameters = createKRateParameters(options.params);
  const output = new Float32Array(input.length);

  for (let offset = 0, blockIndex = 0; offset < input.length; offset += blockSize, blockIndex++) {
    const remaining = Math.min(blockSize, input.length - offset);
    const inputBlock = new Float32Array(blockSize);
    inputBlock.set(input.subarray(offset, offset + remaining));

    const outputBlock = new Float32Array(blockSize);
    processor.process([[inputBlock]], [[outputBlock]], parameters);
    output.set(outputBlock.subarray(0, remaining), offset);

    options.probe?.(processor, { blockIndex, offset, outputBlock });
  }

  return output;
}

export function renderStereo(
  processor: TestProcessor,
  inputLeft: Float32Array,
  inputRight: Float32Array,
  options: RenderOptions = {},
): [Float32Array, Float32Array] {
  if (inputLeft.length !== inputRight.length) {
    throw new Error('Stereo render requires matching channel lengths');
  }

  const blockSize = options.blockSize ?? 128;
  const parameters = createKRateParameters(options.params);
  const outputLeft = new Float32Array(inputLeft.length);
  const outputRight = new Float32Array(inputRight.length);

  for (let offset = 0, blockIndex = 0; offset < inputLeft.length; offset += blockSize, blockIndex++) {
    const remaining = Math.min(blockSize, inputLeft.length - offset);
    const leftBlock = new Float32Array(blockSize);
    const rightBlock = new Float32Array(blockSize);
    leftBlock.set(inputLeft.subarray(offset, offset + remaining));
    rightBlock.set(inputRight.subarray(offset, offset + remaining));

    const outputLeftBlock = new Float32Array(blockSize);
    const outputRightBlock = new Float32Array(blockSize);
    processor.process([[leftBlock, rightBlock]], [[outputLeftBlock, outputRightBlock]], parameters);
    outputLeft.set(outputLeftBlock.subarray(0, remaining), offset);
    outputRight.set(outputRightBlock.subarray(0, remaining), offset);

    options.probe?.(processor, { blockIndex, offset, outputBlock: outputLeftBlock });
  }

  return [outputLeft, outputRight];
}
