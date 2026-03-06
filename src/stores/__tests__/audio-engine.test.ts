import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioEngine } from '../audio-engine';
import { useStageParams } from '../stage-params';
import type { WorkletBridge } from '../../audio/worklet-bridge';
import type { AudioFileLoader } from '../../audio/file-loader';

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
    expect(engine.paramValues.bias).toBeCloseTo(0.75);
    expect(engine.paramValues.drive).toBeCloseTo(0.35);
    expect(engine.paramValues.saturation).toBeCloseTo(0.45);
    expect(engine.paramValues.ampDrive).toBeCloseTo(0.2);
    expect(engine.paramValues.wow).toBeCloseTo(0.12);
    expect(engine.paramValues.flutter).toBeCloseTo(0.06);
    expect(engine.paramValues.hiss).toBeCloseTo(0.04);
    expect(engine.activeStageParams.playbackAmp.drive).toBe(true);

    expect(stages.recordAmp.params.drive).toBeCloseTo(0.2);
    expect(stages.playbackAmp.params.drive).toBeCloseTo(0.16);

    expect(setParam).toHaveBeenCalledWith('bias', 0.75, 12.5);
    expect(setParam).toHaveBeenCalledWith('drive', 0.35, 12.5);
    expect(setParam).toHaveBeenCalledWith('ampDrive', 0.2, 12.5);
    expect(setParam).toHaveBeenCalledWith('wow', 0.12, 12.5);
    expect(setParam).toHaveBeenCalledWith('flutter', 0.06, 12.5);
    expect(setParam).toHaveBeenCalledWith('hiss', 0.04, 12.5);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'set-stage-param',
      stageId: 'playbackAmp',
      param: 'drive',
      value: 0.16,
    });
  });

  it('setRecordCouplingMode updates state and forwards to the worklet', () => {
    const postMessage = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      bridge: { postMessage, setParam: vi.fn() } as unknown as WorkletBridge,
    });

    useAudioEngine.getState().setRecordCouplingMode('predictor');

    expect(useAudioEngine.getState().recordCouplingMode).toBe('predictor');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'set-record-coupling-mode',
      value: 'predictor',
    });
  });

  it('setCouplingAmount clamps state and forwards to the worklet', () => {
    const postMessage = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      bridge: { postMessage, setParam: vi.fn() } as unknown as WorkletBridge,
    });

    useAudioEngine.getState().setCouplingAmount(2.5);

    expect(useAudioEngine.getState().couplingAmount).toBeCloseTo(2.5);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'set-coupling-amount',
      value: 2.5,
    });
  });

  it('setTapeSpeed accepts 30 ips and forwards it to the worklet', () => {
    const postMessage = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      bridge: { postMessage, setParam: vi.fn() } as unknown as WorkletBridge,
    });

    useAudioEngine.getState().setTapeSpeed(30);

    expect(useAudioEngine.getState().tapeSpeed).toBe(30);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'set-speed',
      value: 30,
    });
  });

  it('loadFile auto-aligns source level through the hidden input trim', async () => {
    const play = vi.fn();
    const loadFile = vi.fn().mockResolvedValue(undefined);
    const buffer = {
      sampleRate: 48_000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0.5, -0.5, 0.5, -0.5]),
    } as unknown as AudioBuffer;
    const loader = {
      loadFile,
      getBuffer: () => buffer,
      play,
    } as unknown as AudioFileLoader;
    const setParam = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      audioCtx: {} as AudioContext,
      loader,
      bridge: { postMessage: vi.fn(), setParam } as unknown as WorkletBridge,
    });

    await useAudioEngine.getState().loadFile(new File(['test'], 'test.wav'));

    expect(loadFile).toHaveBeenCalled();
    expect(setParam).toHaveBeenCalledWith('inputGain', expect.any(Number), 0);
    expect(useAudioEngine.getState().paramValues.inputGain).not.toBeCloseTo(1);
    expect(play).toHaveBeenCalled();
  });

  it('preserves the source input trim when switching machine presets', () => {
    const setParam = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      bridge: { postMessage: vi.fn(), setParam } as unknown as WorkletBridge,
      audioCtx: { currentTime: 12.5 } as AudioContext,
      paramValues: {
        ...useAudioEngine.getState().paramValues,
        inputGain: 0.5,
      },
    });

    useStageParams.getState().loadPreset('mci');

    expect(useAudioEngine.getState().paramValues.inputGain).toBeCloseTo(0.5);
    expect(setParam).toHaveBeenCalledWith('inputGain', 0.5, 12.5);
  });

  it('re-aligns the loaded file when the input mode changes', () => {
    const signal = new Float32Array(48_000);
    signal[0] = 0.95;
    signal[1] = 0.5;
    signal[12_000] = 0.95;
    signal[12_001] = 0.5;
    signal[24_000] = 0.95;
    signal[24_001] = 0.5;
    const buffer = {
      sampleRate: 48_000,
      numberOfChannels: 1,
      getChannelData: () => signal,
    } as unknown as AudioBuffer;
    const setParam = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      audioCtx: { currentTime: 12.5 } as AudioContext,
      loader: {
        getBuffer: () => buffer,
      } as unknown as AudioFileLoader,
      bridge: { postMessage: vi.fn(), setParam } as unknown as WorkletBridge,
    });

    useAudioEngine.getState().setInputAlignMode('drums');

    expect(useAudioEngine.getState().inputAlignMode).toBe('drums');
    expect(setParam).toHaveBeenCalledWith('inputGain', expect.any(Number), 12.5);
    expect(useAudioEngine.getState().paramValues.inputGain).toBeLessThanOrEqual(1);
  });
});
