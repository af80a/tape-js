import { describe, expect, it } from 'vitest';
import {
  clampAnalogOutput,
  createOperatingLevelMapping,
  scalePluginInput,
  scalePluginOutput,
} from '../plugin-io';

describe('plugin I/O boundary helpers', () => {
  it('derives inverse analog-domain scaling from headroom', () => {
    const mapping = createOperatingLevelMapping(18);

    expect(mapping.inputToAnalog).toBeCloseTo(Math.pow(10, 18 / 20), 6);
    expect(mapping.analogToDigital).toBeCloseTo(1 / mapping.inputToAnalog, 6);
    expect(mapping.analogClamp).toBeCloseTo(2 * mapping.inputToAnalog, 6);
  });

  it('maps lower headroom to stronger analog drive', () => {
    const clean = createOperatingLevelMapping(36);
    const nominal = createOperatingLevelMapping(18);
    const hot = createOperatingLevelMapping(6);

    expect(clean.inputToAnalog).toBeCloseTo(1, 6);
    expect(hot.inputToAnalog).toBeGreaterThan(nominal.inputToAnalog);
    expect(nominal.inputToAnalog).toBeGreaterThan(clean.inputToAnalog);
  });

  it('round-trips plugin input and output scaling when trims are unity', () => {
    const mapping = createOperatingLevelMapping(18);

    const analogIn = scalePluginInput(0.25, 1.2, mapping);
    const output = scalePluginOutput(analogIn, 1, 1, mapping);

    expect(output.analog).toBeCloseTo(analogIn, 6);
    expect(output.digital).toBeCloseTo(0.25 * 1.2, 6);
  });

  it('clamps analog-domain output symmetrically', () => {
    const mapping = createOperatingLevelMapping(18);

    expect(clampAnalogOutput(mapping.analogClamp * 2, mapping)).toEqual({
      value: mapping.analogClamp,
      clamped: true,
    });
    expect(clampAnalogOutput(-mapping.analogClamp * 2, mapping)).toEqual({
      value: -mapping.analogClamp,
      clamped: true,
    });
    expect(clampAnalogOutput(mapping.analogClamp * 0.5, mapping)).toEqual({
      value: mapping.analogClamp * 0.5,
      clamped: false,
    });
  });

  it('clamps the returned plugin-domain sample after trim and output gain', () => {
    const mapping = createOperatingLevelMapping(18);
    const output = scalePluginOutput(mapping.analogClamp, 35.4, 1, mapping);

    expect(output.digital).toBeLessThanOrEqual(2);
    expect(output.digital).toBeGreaterThanOrEqual(-2);
  });
});
