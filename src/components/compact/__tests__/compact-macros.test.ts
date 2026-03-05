import { describe, expect, it } from 'vitest';
import {
  alignmentToAzimuth,
  applyLinkedGainTrimDelta,
  applyGroupedDelta,
  azimuthToAlignment,
  resolveGroupedNumberState,
  resolveGroupedVariantValue,
} from '../compact-macros';

describe('compact macro helpers', () => {
  it('detects mixed numeric values and uses their average as macro position', () => {
    const state = resolveGroupedNumberState([0.6, 0.45]);

    expect(state.value).toBeCloseTo(0.525);
    expect(state.mixed).toBe(true);
  });

  it('applies relative grouped deltas while preserving offsets', () => {
    expect(applyGroupedDelta([0.6, 0.45], 0.625, 0, 1)).toEqual([0.7, 0.55]);
  });

  it('bounds grouped deltas to keep every value in range', () => {
    expect(applyGroupedDelta([0.9, 0.4], 1, 0, 1)).toEqual([1, 0.5]);
  });

  it('supports transformer-style grouped movement over a wider range', () => {
    expect(applyGroupedDelta([0.8, 0.7], 1.0, 0, 2)).toEqual([1.05, 0.95]);
  });

  it('applies linked gain changes with inverse trim compensation', () => {
    expect(
      applyLinkedGainTrimDelta([1.0, 1.0], [0, 0], 2.0, 0.25, 4, -12, 12),
    ).toEqual({
      gains: [2, 2],
      trims: [-6.020599913279624, -6.020599913279624],
    });
  });

  it('clamps linked trim compensation to the available trim range', () => {
    expect(
      applyLinkedGainTrimDelta([1.0, 1.0], [-10, 11], 4.0, 0.25, 4, -12, 12),
    ).toEqual({
      gains: [4, 4],
      trims: [-12, -1.0411998265592484],
    });
  });

  it('returns a mixed token when grouped variants diverge', () => {
    expect(resolveGroupedVariantValue(['tube', 'transistor'], '__mixed__')).toBe('__mixed__');
    expect(resolveGroupedVariantValue(['tube', 'tube'], '__mixed__')).toBe('tube');
  });

  it('maps compact alignment to inverse azimuth error', () => {
    expect(azimuthToAlignment(0)).toBeCloseTo(1);
    expect(azimuthToAlignment(15)).toBeCloseTo(0.5);
    expect(alignmentToAzimuth(1)).toBeCloseTo(0);
    expect(alignmentToAzimuth(0.5)).toBeCloseTo(15);
  });
});
