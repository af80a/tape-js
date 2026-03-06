import { describe, expect, it } from 'vitest';
import { FORMULAS, PRESETS } from '../../dsp/presets';
import {
  buildPresetActiveStageParams,
  buildPresetParamValues,
  buildStageStates,
  resolveMachinePreset,
  resolveMachinePresetName,
} from '../machine-state';

describe('machine state helpers', () => {
  it('falls back unknown preset names to studer', () => {
    expect(resolveMachinePresetName('unknown-preset')).toBe('studer');
    expect(resolveMachinePreset('unknown-preset')).toBe(PRESETS.studer);
  });

  it('builds preset-backed engine params and stage defaults from the selected machine', () => {
    const preset = PRESETS.ampex;
    const paramValues = buildPresetParamValues(preset);
    const stages = buildStageStates(preset);

    expect(paramValues).toMatchObject({
      inputGain: 1,
      bias: 0.75,
      drive: 0.35,
      saturation: 0.45,
      ampDrive: 0.2,
      wow: 0.12,
      flutter: 0.06,
      hiss: 0.04,
      color: 0,
      outputGain: 1,
    });

    expect(stages.inputXfmr.bypassed).toBe(false);
    expect(stages.inputXfmr.params.inputGain).toBe(1);
    expect(stages.recordAmp.variant).toBe('tube');
    expect(stages.recordAmp.params.drive).toBeCloseTo(0.2);
    expect(stages.recordEQ.variant).toBe('NAB');
    expect(stages.playbackEQ.variant).toBe('NAB');
    expect(stages.hysteresis.params.k).toBeCloseTo(FORMULAS['456'].k);
    expect(stages.hysteresis.params.c).toBeCloseTo(FORMULAS['456'].c);
    expect(stages.playbackAmp.params.drive).toBeCloseTo(0.16);
    expect(stages.transport.params.wow).toBeCloseTo(0.12);
    expect(stages.noise.params.hiss).toBeCloseTo(0.04);
  });

  it('marks only playback amp drive as preset-owned stage state', () => {
    const activeStageParams = buildPresetActiveStageParams();

    expect(activeStageParams.playbackAmp).toEqual({ drive: true });
    expect(activeStageParams.recordAmp).toEqual({});
    expect(activeStageParams.transport).toEqual({});
  });
});
