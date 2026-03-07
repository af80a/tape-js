import { FORMULAS, PRESETS, type MachinePreset } from '../dsp/presets';
import { STAGE_DEFS, STAGE_IDS, type StageId } from '../types/stages';

export const DEFAULT_MACHINE_PRESET = 'studer';

export interface StageState {
  bypassed: boolean;
  variant?: string;
  params: Record<string, number>;
}

export type StageStateMap = Record<StageId, StageState>;
export type ActiveStageParamMap = Record<StageId, Record<string, true>>;

export const AMP_STAGE_IDS = ['recordAmp', 'playbackAmp'] as const satisfies readonly StageId[];

export const PRESET_PARAM_KEYS = [
  'inputGain',
  'bias',
  'drive',
  'saturation',
  'ampDrive',
  'wow',
  'flutter',
  'hiss',
  'color',
  'outputGain',
] as const;

export type PresetParamKey = (typeof PRESET_PARAM_KEYS)[number];

export function isPresetParamKey(name: string): name is PresetParamKey {
  return (PRESET_PARAM_KEYS as readonly string[]).includes(name);
}

export function updateStageState(
  stages: StageStateMap,
  stageId: StageId,
  update: (stage: StageState) => StageState,
): StageStateMap {
  return {
    ...stages,
    [stageId]: update(stages[stageId]),
  };
}

export function updateStageVariants(
  stages: StageStateMap,
  stageIds: readonly StageId[],
  variant: string,
): StageStateMap {
  const nextStages = { ...stages };
  for (const stageId of stageIds) {
    nextStages[stageId] = { ...nextStages[stageId], variant };
  }
  return nextStages;
}

export function initActiveStageParams(): ActiveStageParamMap {
  const active = {} as ActiveStageParamMap;
  for (const id of STAGE_IDS) {
    active[id] = {};
  }
  return active;
}

export function resolveMachinePresetName(presetName: string): string {
  return PRESETS[presetName] ? presetName : DEFAULT_MACHINE_PRESET;
}

export function resolveMachinePreset(presetName: string): MachinePreset {
  return PRESETS[resolveMachinePresetName(presetName)];
}

export function buildPresetParamValues(preset: MachinePreset): Record<PresetParamKey, number> {
  return {
    inputGain: 1.0,
    bias: preset.defaults.bias,
    drive: preset.defaults.hysteresisDrive,
    saturation: preset.defaults.hysteresisSaturation,
    ampDrive: preset.defaults.recordAmpDrive,
    wow: preset.defaults.wow,
    flutter: preset.defaults.flutter,
    hiss: preset.defaults.hiss,
    color: 0,
    outputGain: 1.0,
  };
}

export function buildPresetActiveStageParams(): ActiveStageParamMap {
  const active = initActiveStageParams();
  // Playback amp has its own preset drive and cannot be reconstructed
  // exactly from the single global `ampDrive` AudioParam.
  active.playbackAmp.drive = true;
  return active;
}

function buildDefaultStageStates(): StageStateMap {
  const stages = {} as StageStateMap;

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

  return stages;
}

export function buildStageStates(preset: MachinePreset): StageStateMap {
  const stages = buildDefaultStageStates();

  stages.inputXfmr.params.satAmount = preset.inputTransformer.satAmount;
  stages.inputXfmr.params.hfResonance = preset.inputTransformer.hfResonance;
  stages.inputXfmr.params.hfQ = preset.inputTransformer.hfQ;
  stages.inputXfmr.params.lfCutoff = preset.inputTransformer.lfCutoff;

  stages.recordAmp.variant = preset.ampType;
  stages.recordAmp.params.drive = preset.defaults.recordAmpDrive;
  if (preset.recordAmpConfig?.tubeCircuit) {
    stages.recordAmp.params.Vpp = preset.recordAmpConfig.tubeCircuit.Vpp;
  }

  stages.recordEQ.variant = preset.eqStandard;
  stages.playbackEQ.variant = preset.eqStandard;

  stages.bias.params.level = preset.defaults.bias;

  stages.hysteresis.params.drive = preset.defaults.hysteresisDrive;
  stages.hysteresis.params.saturation = preset.defaults.hysteresisSaturation;
  const formula = FORMULAS[preset.defaultFormula] ?? FORMULAS['456'];
  stages.hysteresis.params.k = formula.k;
  stages.hysteresis.params.c = formula.c;

  stages.head.params.bumpGainDb = preset.bumpGainDb;
  stages.head.params.azimuth = preset.defaults.azimuth;
  stages.head.params.weave = preset.defaults.weave;

  stages.transport.params.wow = preset.defaults.wow;
  stages.transport.params.flutter = preset.defaults.flutter;

  stages.playbackAmp.variant = preset.ampType;
  stages.playbackAmp.params.drive = preset.defaults.playbackAmpDrive;
  if (preset.playbackAmpConfig?.tubeCircuit) {
    stages.playbackAmp.params.Vpp = preset.playbackAmpConfig.tubeCircuit.Vpp;
  }

  stages.outputXfmr.params.satAmount = preset.outputTransformer.satAmount;
  stages.outputXfmr.params.hfResonance = preset.outputTransformer.hfResonance;
  stages.outputXfmr.params.hfQ = preset.outputTransformer.hfQ;
  stages.outputXfmr.params.lfCutoff = preset.outputTransformer.lfCutoff;

  stages.noise.params.hiss = preset.defaults.hiss;

  return stages;
}
