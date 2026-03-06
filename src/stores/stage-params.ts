import { create } from 'zustand';
import { type StageId } from '../types/stages';
import { useAudioEngine } from './audio-engine';
import {
  AMP_STAGE_IDS,
  DEFAULT_MACHINE_PRESET,
  buildStageStates,
  resolveMachinePreset,
  resolveMachinePresetName,
  updateStageState,
  updateStageVariants,
  type StageStateMap,
} from './machine-state';

interface StageParamsState {
  stages: StageStateMap;

  setStageBypass: (stageId: StageId, bypassed: boolean) => void;
  setStageVariant: (stageId: StageId, variant: string) => void;
  setStageParam: (stageId: StageId, param: string, value: number) => void;
  setAmpType: (ampType: 'tube' | 'transistor') => void;
  loadPreset: (presetName: string) => void;
}
const defaultPreset = resolveMachinePreset(DEFAULT_MACHINE_PRESET);

export const useStageParams = create<StageParamsState>((set) => ({
  stages: buildStageStates(defaultPreset),

  setStageBypass: (stageId, bypassed) => {
    useAudioEngine.getState().postMessage({
      type: 'set-stage-bypass',
      stageId,
      value: bypassed,
    });
    set((state) => ({
      stages: updateStageState(state.stages, stageId, (stage) => ({ ...stage, bypassed })),
    }));
  },

  setStageVariant: (stageId, variant) => {
    useAudioEngine.getState().postMessage({
      type: 'set-stage-variant',
      stageId,
      value: variant,
    });
    set((state) => ({
      stages: updateStageState(state.stages, stageId, (stage) => ({ ...stage, variant })),
    }));
  },

  setAmpType: (ampType) => {
    const { postMessage } = useAudioEngine.getState();
    for (const stageId of AMP_STAGE_IDS) {
      postMessage({
        type: 'set-stage-variant',
        stageId,
        value: ampType,
      });
    }
    set((state) => ({
      stages: updateStageVariants(state.stages, AMP_STAGE_IDS, ampType),
    }));
  },

  setStageParam: (stageId, param, value) => {
    useAudioEngine.getState().postMessage({
      type: 'set-stage-param',
      stageId,
      param,
      value,
    });
    set((state) => ({
      stages: updateStageState(state.stages, stageId, (stage) => ({
        ...stage,
        params: { ...stage.params, [param]: value },
      })),
    }));
  },

  loadPreset: (presetName) => {
    const resolvedPresetName = resolveMachinePresetName(presetName);
    const preset = resolveMachinePreset(resolvedPresetName);
    const nextStages = buildStageStates(preset);
    useAudioEngine.getState().setMachinePreset(resolvedPresetName, nextStages);
    set({
      stages: nextStages,
    });
  },
}));
