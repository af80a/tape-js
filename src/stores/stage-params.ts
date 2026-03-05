import { create } from 'zustand';
import { STAGE_IDS, STAGE_DEFS, type StageId } from '../types/stages';
import { PRESETS, FORMULAS, type MachinePreset } from '../dsp/presets';
import { useAudioEngine } from './audio-engine';

interface StageState {
  bypassed: boolean;
  variant?: string;
  params: Record<string, number>;
}

interface StageParamsState {
  stages: Record<StageId, StageState>;
  currentPreset: string;

  setStageBypass: (stageId: StageId, bypassed: boolean) => void;
  setStageVariant: (stageId: StageId, variant: string) => void;
  setStageParam: (stageId: StageId, param: string, value: number) => void;
  setAmpType: (ampType: 'tube' | 'transistor') => void;
  loadPreset: (presetName: string) => void;
}

const AMP_STAGE_IDS = ['recordAmp', 'playbackAmp'] as const satisfies readonly StageId[];

function updateStageState(
  stages: Record<StageId, StageState>,
  stageId: StageId,
  update: (stage: StageState) => StageState,
): Record<StageId, StageState> {
  return {
    ...stages,
    [stageId]: update(stages[stageId]),
  };
}

function updateStageVariants(
  stages: Record<StageId, StageState>,
  stageIds: readonly StageId[],
  variant: string,
): Record<StageId, StageState> {
  const nextStages = { ...stages };
  for (const stageId of stageIds) {
    nextStages[stageId] = { ...nextStages[stageId], variant };
  }
  return nextStages;
}

function buildStageStates(preset: MachinePreset): Record<StageId, StageState> {
  const stages = {} as Record<StageId, StageState>;

  for (const id of STAGE_IDS) {
    const def = STAGE_DEFS[id];
    const params: Record<string, number> = {};

    for (const [key, paramDef] of Object.entries(def.params)) {
      params[key] = paramDef.default;
    }

    stages[id] = {
      bypassed: false,
      variant: def.variants?.[0]?.value,
      params,
    };
  }

  // Populate from preset
  stages.inputXfmr.params.satAmount = preset.inputTransformer.satAmount;
  stages.inputXfmr.params.hfResonance = preset.inputTransformer.hfResonance;
  stages.inputXfmr.params.hfQ = preset.inputTransformer.hfQ;
  stages.inputXfmr.params.lfCutoff = preset.inputTransformer.lfCutoff;

  stages.recordAmp.variant = preset.ampType;
  stages.recordAmp.params.drive = preset.recordAmpDrive;
  if (preset.tubeCircuit) {
    stages.recordAmp.params.Vpp = preset.tubeCircuit.Vpp;
  }

  stages.recordEQ.variant = preset.eqStandard;
  stages.playbackEQ.variant = preset.eqStandard;

  stages.bias.params.level = preset.biasDefault;

  stages.hysteresis.params.drive = preset.drive;
  stages.hysteresis.params.saturation = preset.saturation;
  const f = FORMULAS[preset.defaultFormula] ?? FORMULAS['456'];
  stages.hysteresis.params.k = f.k;
  stages.hysteresis.params.c = f.c;

  stages.head.params.bumpGainDb = preset.bumpGainDb;

  stages.transport.params.wow = preset.wowDefault;
  stages.transport.params.flutter = preset.flutterDefault;

  stages.playbackAmp.variant = preset.ampType;
  stages.playbackAmp.params.drive = preset.playbackAmpDrive;
  if (preset.tubeCircuit) {
    stages.playbackAmp.params.Vpp = preset.tubeCircuit.Vpp;
  }

  stages.outputXfmr.params.satAmount = preset.outputTransformer.satAmount;
  stages.outputXfmr.params.hfResonance = preset.outputTransformer.hfResonance;
  stages.outputXfmr.params.hfQ = preset.outputTransformer.hfQ;
  stages.outputXfmr.params.lfCutoff = preset.outputTransformer.lfCutoff;

  stages.noise.params.hiss = preset.hissDefault;

  return stages;
}

const defaultPreset = PRESETS['studer'];

export const useStageParams = create<StageParamsState>((set) => ({
  stages: buildStageStates(defaultPreset),
  currentPreset: 'studer',

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
    const resolvedPresetName = PRESETS[presetName] ? presetName : 'studer';
    const preset = PRESETS[resolvedPresetName];
    const nextStages = buildStageStates(preset);
    useAudioEngine.getState().setMachinePreset(resolvedPresetName, nextStages);
    set({
      currentPreset: resolvedPresetName,
      stages: nextStages,
    });
  },
}));
