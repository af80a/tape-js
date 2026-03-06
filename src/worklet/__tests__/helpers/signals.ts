export interface ToneComponent {
  frequency: number;
  amplitude: number;
  phase?: number;
}

export interface WindowedBurstOptions {
  start: number;
  length: number;
  frequency: number;
  amplitude: number;
  phase?: number;
}

export function generateSine(
  length: number,
  sampleRate: number,
  frequency: number,
  amplitude = 1,
  phase = 0,
  startSample = 0,
): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin(w * (startSample + i) + phase);
  }
  return out;
}

export function generateTwoTone(
  length: number,
  sampleRate: number,
  tones: ToneComponent[],
  startSample = 0,
): Float32Array {
  const out = new Float32Array(length);
  for (const tone of tones) {
    const w = (2 * Math.PI * tone.frequency) / sampleRate;
    const phase = tone.phase ?? 0;
    for (let i = 0; i < length; i++) {
      out[i] += tone.amplitude * Math.sin(w * (startSample + i) + phase);
    }
  }
  return out;
}

export function generateWindowedSineBurst(
  totalLength: number,
  sampleRate: number,
  options: WindowedBurstOptions,
): Float32Array {
  const out = new Float32Array(totalLength);
  const start = Math.max(0, options.start);
  const length = Math.max(0, Math.min(options.length, totalLength - start));
  const phase = options.phase ?? 0;
  const w = (2 * Math.PI * options.frequency) / sampleRate;

  if (length <= 1) {
    return out;
  }

  for (let i = 0; i < length; i++) {
    const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    const sampleIndex = start + i;
    out[sampleIndex] = options.amplitude * env * Math.sin(w * sampleIndex + phase);
  }

  return out;
}
