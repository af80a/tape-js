import type { StageId } from './stages';

/** Messages sent TO the worklet via port.postMessage */
export type WorkletMessage =
  | { type: 'set-preset'; value: string }
  | { type: 'set-speed'; value: number }
  | { type: 'set-oversample'; value: number }
  | { type: 'set-coupling-amount'; value: number }
  | { type: 'set-record-coupling-mode'; value: 'delayed' | 'predictor' }
  | { type: 'set-formula'; value: string }
  | { type: 'set-bypass'; value: boolean }
  | { type: 'set-stage-bypass'; stageId: StageId; value: boolean }
  | { type: 'set-stage-variant'; stageId: StageId; value: string }
  | { type: 'set-stage-param'; stageId: StageId; param: string; value: number }
  | { type: 'clear-param-overrides' }
  | { type: 'dispose' };

/** Messages received FROM the worklet via port.onmessage */
export type WorkletResponse =
  | { type: 'meters'; vuDb: number[]; peakDb: number[] }
  | { type: 'stage-meters'; levels: Record<string, { vuDb: number[]; peakDb: number[]; saturation?: number }> }
  | { type: 'render-progress'; progress: number }
  | {
      type: 'debug-stats';
      timerSource: 'perf' | 'date';
      overrunsPerSec: number;
      nanAmpCount: number;
      nanHystCount?: number;
      outRms?: number[];
      outDc?: number[];
      outPeak?: number[];
      outClampHits?: number[];
      outNonFinite?: number[];
      lrImbalanceDb?: number;
      maxProcessMs: number;
      avgProcessMs: number;
      avgRecordMs: number;
      avgPlaybackMs: number;
      budgetMs: number;
    };
