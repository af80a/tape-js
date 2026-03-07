/**
 * Plugin-boundary operating-level helpers.
 *
 * These functions map between the plugin's digital signal domain and the
 * worklet's analog-model domain. They are intentionally separate from the
 * machine simulation so plugin calibration, safety ceilings, and output trims
 * do not read like tape-physics parameters.
 */

export const MAX_HEADROOM_DB = 36;
const DIGITAL_CLIP_CEILING = 2;

export interface OperatingLevelMapping {
  inputToAnalog: number;
  analogToDigital: number;
  analogClamp: number;
}

export interface AnalogClampResult {
  value: number;
  clamped: boolean;
}

export interface PluginOutputScaling {
  analog: number;
  digital: number;
}

export function createOperatingLevelMapping(
  headroomDb: number,
  maxHeadroomDb = MAX_HEADROOM_DB,
): OperatingLevelMapping {
  const inputToAnalog = Math.pow(10, (maxHeadroomDb - headroomDb) / 20);
  return {
    inputToAnalog,
    analogToDigital: 1 / inputToAnalog,
    analogClamp: DIGITAL_CLIP_CEILING * inputToAnalog,
  };
}

export function scalePluginInput(
  sample: number,
  inputGain: number,
  mapping: OperatingLevelMapping,
): number {
  return sample * inputGain * mapping.inputToAnalog;
}

export function clampAnalogOutput(
  sample: number,
  mapping: Pick<OperatingLevelMapping, 'analogClamp'>,
): AnalogClampResult {
  if (sample > mapping.analogClamp) {
    return { value: mapping.analogClamp, clamped: true };
  }
  if (sample < -mapping.analogClamp) {
    return { value: -mapping.analogClamp, clamped: true };
  }
  return { value: sample, clamped: false };
}

export function scalePluginOutput(
  analogSample: number,
  outputTrim: number,
  outputGain: number,
  mapping: Pick<OperatingLevelMapping, 'analogToDigital'>,
): PluginOutputScaling {
  const analog = analogSample * outputTrim * outputGain;
  const digital = analog * mapping.analogToDigital;
  return {
    analog,
    digital: Math.max(-DIGITAL_CLIP_CEILING, Math.min(DIGITAL_CLIP_CEILING, digital)),
  };
}
