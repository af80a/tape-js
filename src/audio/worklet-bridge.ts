import type { WorkletMessage, WorkletResponse } from '../types/messages';

/**
 * Typed wrapper around AudioWorkletNode for communicating with the tape processor.
 */
export class WorkletBridge {
  readonly node: AudioWorkletNode;

  constructor(node: AudioWorkletNode) {
    this.node = node;
  }

  /** Set a k-rate AudioParam value. */
  setParam(name: string, value: number, time = 0): void {
    const param = this.node.parameters.get(name);
    if (param) {
      param.setValueAtTime(value, time);
    }
  }

  /** Send a typed message to the worklet. */
  postMessage(msg: WorkletMessage): void {
    this.node.port.postMessage(msg);
  }

  /** Listen for typed messages from the worklet. */
  onMessage(handler: (msg: WorkletResponse) => void): void {
    this.node.port.onmessage = (e: MessageEvent) => {
      handler(e.data as WorkletResponse);
    };
  }

  /** Connect the worklet node to a destination. */
  connect(dest: AudioNode): void {
    this.node.connect(dest);
  }

  /** Disconnect the worklet node. */
  disconnect(): void {
    this.node.disconnect();
  }
}

export function getWorkletUrl(): string {
  return import.meta.env.DEV
    ? '/src/worklet/tape-processor.ts'
    : '/worklets/tape-processor.js';
}

/**
 * Create the AudioContext, load the worklet module, and return a WorkletBridge.
 */
export async function createWorkletBridge(
  audioCtx: AudioContext,
  preset = 'studer',
  oversample = 2,
  tapeSpeed = 15,
  couplingAmount = 1,
  recordCouplingMode: 'delayed' | 'predictor' = 'delayed',
): Promise<WorkletBridge> {
  await audioCtx.audioWorklet.addModule(getWorkletUrl());

  const node = new AudioWorkletNode(audioCtx, 'tape-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { preset, oversample, tapeSpeed, couplingAmount, recordCouplingMode },
  });
  node.connect(audioCtx.destination);

  return new WorkletBridge(node);
}
