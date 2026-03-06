function clampWindow(length: number, start: number, end: number): [number, number] {
  const safeStart = Math.max(0, Math.min(length, start));
  const safeEnd = Math.max(safeStart, Math.min(length, end));
  return [safeStart, safeEnd];
}

export function rms(signal: Float32Array, start = 0, end = signal.length): number {
  const [from, to] = clampWindow(signal.length, start, end);
  let sumSq = 0;
  for (let i = from; i < to; i++) {
    sumSq += signal[i] * signal[i];
  }
  const count = Math.max(1, to - from);
  return Math.sqrt(sumSq / count);
}

export function peakAbs(signal: Float32Array, start = 0, end = signal.length): number {
  const [from, to] = clampWindow(signal.length, start, end);
  let peak = 0;
  for (let i = from; i < to; i++) {
    const value = Math.abs(signal[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

export function dcOffset(signal: Float32Array, start = 0, end = signal.length): number {
  const [from, to] = clampWindow(signal.length, start, end);
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += signal[i];
  }
  const count = Math.max(1, to - from);
  return sum / count;
}

export function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

export function crestFactorDb(signal: Float32Array, start = 0, end = signal.length): number {
  return db(peakAbs(signal, start, end) / Math.max(rms(signal, start, end), 1e-12));
}

export function goertzelMagnitude(
  signal: Float32Array,
  sampleRate: number,
  frequency: number,
  start = 0,
  end = signal.length,
): number {
  const [from, to] = clampWindow(signal.length, start, end);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;

  for (let i = from; i < to; i++) {
    const s0 = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  const count = Math.max(1, to - from);
  return Math.sqrt(Math.max(0, power)) / count;
}

export function matchRmsGain(
  reference: Float32Array,
  candidate: Float32Array,
  start = 0,
  end = Math.min(reference.length, candidate.length),
): number {
  return rms(reference, start, end) / Math.max(rms(candidate, start, end), 1e-12);
}

export function residualRms(
  reference: Float32Array,
  candidate: Float32Array,
  gain = 1,
  start = 0,
  end = Math.min(reference.length, candidate.length),
): number {
  const [from, to] = clampWindow(Math.min(reference.length, candidate.length), start, end);
  let sumSq = 0;
  for (let i = from; i < to; i++) {
    const residual = reference[i] - candidate[i] * gain;
    sumSq += residual * residual;
  }
  const count = Math.max(1, to - from);
  return Math.sqrt(sumSq / count);
}

export interface HarmonicProfile {
  fundamental: number;
  harmonics: number[];
  thd: number;
}

export function harmonicProfile(
  signal: Float32Array,
  sampleRate: number,
  fundamentalHz: number,
  harmonicCount: number,
  start = 0,
  end = signal.length,
): HarmonicProfile {
  const fundamental = goertzelMagnitude(signal, sampleRate, fundamentalHz, start, end);
  const harmonics: number[] = [];

  for (let harmonic = 2; harmonic <= harmonicCount; harmonic++) {
    harmonics.push(goertzelMagnitude(signal, sampleRate, fundamentalHz * harmonic, start, end));
  }

  const harmonicPower = harmonics.reduce((sumSq, magnitude) => sumSq + magnitude * magnitude, 0);
  const thd = Math.sqrt(harmonicPower) / Math.max(fundamental, 1e-12);

  return {
    fundamental,
    harmonics,
    thd,
  };
}
