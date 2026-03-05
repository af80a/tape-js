const MIX_EPSILON = 1e-6;
const MAX_AZIMUTH_ARCMIN = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface GroupedControlState {
  value: number;
  mixed: boolean;
}

export function resolveGroupedNumberState(values: readonly number[]): GroupedControlState {
  const count = values.length;
  if (count === 0) {
    return { value: 0, mixed: false };
  }

  const value = values.reduce((sum, current) => sum + current, 0) / count;
  const mixed = values.some((current) => Math.abs(current - value) > MIX_EPSILON);
  return { value, mixed };
}

export function applyGroupedDelta(
  values: readonly number[],
  nextValue: number,
  min: number,
  max: number,
): number[] {
  const current = resolveGroupedNumberState(values).value;
  const requestedDelta = nextValue - current;
  const minDelta = Math.max(...values.map((value) => min - value));
  const maxDelta = Math.min(...values.map((value) => max - value));
  const delta = Math.max(minDelta, Math.min(maxDelta, requestedDelta));

  return values.map((value) => value + delta);
}

export interface LinkedGainTrimResult {
  gains: number[];
  trims: number[];
}

export function applyLinkedGainTrimDelta(
  gains: readonly number[],
  trims: readonly number[],
  nextValue: number,
  gainMin: number,
  gainMax: number,
  trimMin: number,
  trimMax: number,
): LinkedGainTrimResult {
  const nextGains = applyGroupedDelta(gains, nextValue, gainMin, gainMax);
  const nextTrims = trims.map((trim, index) => {
    const prevGain = gains[index];
    const nextGain = nextGains[index];
    const deltaDb = 20 * Math.log10(nextGain / prevGain);
    return clamp(trim - deltaDb, trimMin, trimMax);
  });

  return { gains: nextGains, trims: nextTrims };
}

export function resolveGroupedVariantValue(
  values: readonly (string | undefined)[],
  mixedValue: string,
): string {
  const [first] = values;
  if (!first) return mixedValue;
  return values.every((value) => value === first) ? first : mixedValue;
}

export function azimuthToAlignment(azimuthArcmin: number): number {
  return 1 - clamp(azimuthArcmin / MAX_AZIMUTH_ARCMIN, 0, 1);
}

export function alignmentToAzimuth(alignment: number): number {
  return (1 - clamp(alignment, 0, 1)) * MAX_AZIMUTH_ARCMIN;
}
