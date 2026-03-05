import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioEngine } from '../audio-engine';
import { useStageParams } from '../stage-params';

const initialAudioEngineState = useAudioEngine.getState();
const initialStageParamsState = useStageParams.getState();

afterEach(() => {
  useAudioEngine.setState(initialAudioEngineState, true);
  useStageParams.setState(initialStageParamsState, true);
});

describe('Stage param amp type sync', () => {
  it('setAmpType aligns both amp stages through per-stage variant messages', () => {
    const postMessage = vi.fn();

    useAudioEngine.setState({
      ...useAudioEngine.getState(),
      postMessage,
    });

    useStageParams.getState().setStageVariant('playbackAmp', 'transistor');
    postMessage.mockClear();

    useStageParams.getState().setAmpType('tube');

    const { recordAmp, playbackAmp } = useStageParams.getState().stages;

    expect(recordAmp.variant).toBe('tube');
    expect(playbackAmp.variant).toBe('tube');
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      type: 'set-stage-variant',
      stageId: 'recordAmp',
      value: 'tube',
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      type: 'set-stage-variant',
      stageId: 'playbackAmp',
      value: 'tube',
    });
  });
});
