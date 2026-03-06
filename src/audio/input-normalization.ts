export const INPUT_ALIGN_MODES = ['mix', 'track', 'drums', 'bass'] as const;
export type InputAlignMode = (typeof INPUT_ALIGN_MODES)[number];

interface InputAlignConfig {
  targetProgramRmsDbfs: number;
  windowSeconds: number;
  hopSeconds: number;
  absoluteGateDbfs: number;
  programPercentile: number;
  peakCeilingDbfs: number;
  minInputGain: number;
  maxInputGain: number;
}

const INPUT_ALIGN_CONFIGS: Record<InputAlignMode, InputAlignConfig> = {
  mix: {
    targetProgramRmsDbfs: -18,
    windowSeconds: 0.3,
    hopSeconds: 0.1,
    absoluteGateDbfs: -42,
    programPercentile: 0.9,
    peakCeilingDbfs: -3,
    minInputGain: 0.25,
    maxInputGain: 4.0,
  },
  track: {
    targetProgramRmsDbfs: -20,
    windowSeconds: 0.25,
    hopSeconds: 0.1,
    absoluteGateDbfs: -45,
    programPercentile: 0.88,
    peakCeilingDbfs: -6,
    minInputGain: 0.25,
    maxInputGain: 3.0,
  },
  drums: {
    targetProgramRmsDbfs: -24,
    windowSeconds: 0.15,
    hopSeconds: 0.05,
    absoluteGateDbfs: -48,
    programPercentile: 0.82,
    peakCeilingDbfs: -10,
    minInputGain: 0.25,
    maxInputGain: 2.0,
  },
  bass: {
    targetProgramRmsDbfs: -22,
    windowSeconds: 0.25,
    hopSeconds: 0.08,
    absoluteGateDbfs: -45,
    programPercentile: 0.85,
    peakCeilingDbfs: -8,
    minInputGain: 0.25,
    maxInputGain: 2.5,
  },
};

export interface InputAlignmentMetrics {
  mode: InputAlignMode;
  programRmsDbfs: number;
  samplePeakDbfs: number;
  recommendedInputGain: number;
  activeWindowCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function linearToDb(linear: number): number {
  return 20 * Math.log10(Math.max(linear, 1e-12));
}

function percentile(sortedValues: readonly number[], value: number): number {
  if (sortedValues.length === 0) return value;
  if (sortedValues.length === 1) return sortedValues[0];

  const position = clamp(value, 0, 1) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const mix = position - lower;
  return sortedValues[lower] * (1 - mix) + sortedValues[upper] * mix;
}

export function analyzeInputAlignment(
  channels: readonly Float32Array[],
  sampleRate: number,
  mode: InputAlignMode = 'mix',
): InputAlignmentMetrics {
  const config = INPUT_ALIGN_CONFIGS[mode];
  if (channels.length === 0 || sampleRate <= 0) {
    return {
      mode,
      programRmsDbfs: config.targetProgramRmsDbfs,
      samplePeakDbfs: -Infinity,
      recommendedInputGain: 1,
      activeWindowCount: 0,
    };
  }

  const frameCount = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  if (frameCount === 0) {
    return {
      mode,
      programRmsDbfs: config.targetProgramRmsDbfs,
      samplePeakDbfs: -Infinity,
      recommendedInputGain: 1,
      activeWindowCount: 0,
    };
  }

  const windowSize = Math.max(1, Math.round(config.windowSeconds * sampleRate));
  const hopSize = Math.max(1, Math.round(config.hopSeconds * sampleRate));
  const gateLinear = dbToLinear(config.absoluteGateDbfs);
  const windowRmsValues: number[] = [];
  let peak = 0;

  for (let start = 0; start < frameCount; start += hopSize) {
    const end = Math.min(frameCount, start + windowSize);
    let sumSq = 0;
    let count = 0;

    for (let frame = start; frame < end; frame++) {
      let framePower = 0;
      for (let ch = 0; ch < channels.length; ch++) {
        const sample = channels[ch][frame] ?? 0;
        peak = Math.max(peak, Math.abs(sample));
        framePower += sample * sample;
      }
      sumSq += framePower / channels.length;
      count++;
    }

    if (count === 0) continue;
    const rms = Math.sqrt(sumSq / count);
    if (rms >= gateLinear) {
      windowRmsValues.push(rms);
    }
  }

  if (windowRmsValues.length === 0) {
    return {
      mode,
      programRmsDbfs: config.targetProgramRmsDbfs,
      samplePeakDbfs: linearToDb(peak),
      recommendedInputGain: 1,
      activeWindowCount: 0,
    };
  }

  windowRmsValues.sort((a, b) => a - b);
  const programRms = percentile(windowRmsValues, config.programPercentile);
  const programRmsDbfs = linearToDb(programRms);
  const samplePeakDbfs = linearToDb(peak);
  const gainDb = config.targetProgramRmsDbfs - programRmsDbfs;
  const peakProtectedGainDb = config.peakCeilingDbfs - samplePeakDbfs;
  const recommendedInputGain = clamp(
    dbToLinear(Math.min(gainDb, peakProtectedGainDb)),
    config.minInputGain,
    config.maxInputGain,
  );

  return {
    mode,
    programRmsDbfs,
    samplePeakDbfs,
    recommendedInputGain,
    activeWindowCount: windowRmsValues.length,
  };
}

export function analyzeAudioBufferInputAlignment(
  buffer: AudioBuffer,
  mode: InputAlignMode = 'mix',
): InputAlignmentMetrics {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }
  return analyzeInputAlignment(channels, buffer.sampleRate, mode);
}
