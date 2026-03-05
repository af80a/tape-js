import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioEngine } from '../audio-engine';
import { useStageParams } from '../stage-params';
import type { WorkletBridge } from '../../audio/worklet-bridge';

const initialAudioEngineState = useAudioEngine.getState();
const initialStageParamsState = useStageParams.getState();

afterEach(() => {
  useAudioEngine.setState(initialAudioEngineState, true);
  useStageParams.setState(initialStageParamsState, true);
});

describe('Audio engine preset sync', () => {
  it('loadPreset syncs preset-backed params and playback amp drive to the worklet', () => {
    const postMessage = vi.fn();
    const setParam = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      bridge: { postMessage, setParam } as unknown as WorkletBridge,
      audioCtx: { currentTime: 12.5 } as AudioContext,
    });

    useStageParams.getState().loadPreset('ampex');

    const engine = useAudioEngine.getState();
    const stages = useStageParams.getState().stages;

    expect(engine.machinePreset).toBe('ampex');
    expect(engine.formula).toBe('456');
    expect(engine.paramValues.bias).toBeCloseTo(0.55);
    expect(engine.paramValues.drive).toBeCloseTo(0.5);
    expect(engine.paramValues.saturation).toBeCloseTo(0.6);
    expect(engine.paramValues.ampDrive).toBeCloseTo(0.6);
    expect(engine.paramValues.wow).toBeCloseTo(0.12);
    expect(engine.paramValues.flutter).toBeCloseTo(0.06);
    expect(engine.paramValues.hiss).toBeCloseTo(0.04);
    expect(engine.activeStageParams.playbackAmp.drive).toBe(true);

    expect(stages.recordAmp.params.drive).toBeCloseTo(0.6);
    expect(stages.playbackAmp.params.drive).toBeCloseTo(0.45);

    expect(setParam).toHaveBeenCalledWith('bias', 0.55, 12.5);
    expect(setParam).toHaveBeenCalledWith('drive', 0.5, 12.5);
    expect(setParam).toHaveBeenCalledWith('ampDrive', 0.6, 12.5);
    expect(setParam).toHaveBeenCalledWith('wow', 0.12, 12.5);
    expect(setParam).toHaveBeenCalledWith('flutter', 0.06, 12.5);
    expect(setParam).toHaveBeenCalledWith('hiss', 0.04, 12.5);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'set-stage-param',
      stageId: 'playbackAmp',
      param: 'drive',
      value: 0.45,
    });
  });
});
