export const STAGE_IDS = [
  'inputXfmr',
  'recordAmp',
  'recordEQ',
  'bias',
  'hysteresis',
  'head',
  'transport',
  'noise',
  'playbackEQ',
  'playbackAmp',
  'outputXfmr',
  'output',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export interface StageParamDef {
  label: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  /** Only show this param when the stage variant is 'tube'. */
  tubeOnly?: boolean;
}

export interface StageDef {
  id: StageId;
  label: string;
  params: Record<string, StageParamDef>;
  variants?: { value: string; label: string }[];
}

const fmtHz = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)} Hz`;
const fmtDb = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
const fmtLinDb = (v: number) => { const db = 20 * Math.log10(v); return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`; };
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtV = (v: number) => `${Math.round(v)}V`;

const TRIM_PARAM: StageParamDef = { label: 'Trim', min: -12, max: 12, default: 0, step: 0.1, formatValue: fmtDb };

export const STAGE_DEFS: Record<StageId, StageDef> = {
  inputXfmr: {
    id: 'inputXfmr',
    label: 'Input Transformer',
    params: {
      inputGain: { label: 'Input', min: 0.25, max: 4.0, default: 1.0, step: 0.01, formatValue: fmtLinDb },
      satAmount: { label: 'Core Drive', min: 0, max: 2, default: 1.0, step: 0.01, formatValue: (v) => v.toFixed(2) },
      hfResonance: { label: 'HF Resonance', min: 5000, max: 22000, default: 20000, formatValue: fmtHz },
      hfQ: { label: 'Resonance Q', min: 0.3, max: 2.0, default: 0.7, step: 0.01, formatValue: (v) => v.toFixed(2) },
      lfCutoff: { label: 'LF Cutoff', min: 5, max: 100, default: 20, formatValue: fmtHz },
      _trim: TRIM_PARAM,
    },
  },
  recordAmp: {
    id: 'recordAmp',
    label: 'Record Amplifier',
    variants: [
      { value: 'tube', label: 'Tube' },
      { value: 'transistor', label: 'Transistor' },
    ],
    params: {
      drive: { label: 'Stage Drive', min: 0, max: 1, default: 0.5, formatValue: fmtPct },
      Vpp: { label: 'Plate V', min: 200, max: 350, default: 250, formatValue: fmtV, tubeOnly: true },
      _trim: TRIM_PARAM,
    },
  },
  recordEQ: {
    id: 'recordEQ',
    label: 'Record EQ',
    variants: [
      { value: 'NAB', label: 'NAB' },
      { value: 'IEC', label: 'IEC' },
    ],
    params: {
      color: { label: 'Alignment Offset', min: -1, max: 1, default: 0, step: 0.01, formatValue: (v) => v === 0 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(2)}` },
      _trim: TRIM_PARAM,
    },
  },
  bias: {
    id: 'bias',
    label: 'Bias',
    params: {
      level: { label: 'Level', min: 0, max: 1, default: 0.5, formatValue: (v) => v.toFixed(2) },
    },
  },
  hysteresis: {
    id: 'hysteresis',
    label: 'Hysteresis',
    params: {
      drive: { label: 'Field Drive', min: 0, max: 1, default: 0.5, formatValue: fmtPct },
      saturation: { label: 'Saturation', min: 0, max: 1, default: 0.5, formatValue: fmtPct },
      k: { label: 'Pinning (k)', min: 0.1, max: 1.0, default: 0.47875, step: 0.001, formatValue: (v) => v.toFixed(3) },
      c: { label: 'Base Reversibility (c)', min: 0.01, max: 0.5, default: 0.1, step: 0.01, formatValue: (v) => v.toFixed(2) },
      _trim: TRIM_PARAM,
    },
  },
  head: {
    id: 'head',
    label: 'Head Model',
    params: {
      bumpGainDb: { label: 'Bump Gain', min: -6, max: 6, default: 3.0, step: 0.1, formatValue: fmtDb },
      dropouts: { label: 'Dropouts', min: 0, max: 1, default: 0.0, step: 0.01, formatValue: fmtPct },
      crosstalk: { label: 'Crosstalk', min: 0, max: 0.25, default: 0.006, step: 0.001, formatValue: fmtPct },
      azimuth: { label: 'Azimuth', min: 0, max: 30, default: 1.0, step: 0.1, formatValue: (v: number) => `${v.toFixed(1)}'` },
      weave: { label: 'Weave', min: 0, max: 5, default: 0.2, step: 0.01, formatValue: (v: number) => `${v.toFixed(2)}'` },
      _trim: TRIM_PARAM,
    },
  },
  transport: {
    id: 'transport',
    label: 'Transport',
    params: {
      wow: { label: 'Wow', min: 0, max: 1, default: 0.15, formatValue: fmtPct },
      flutter: { label: 'Flutter', min: 0, max: 1, default: 0.1, formatValue: fmtPct },
      wowRate: { label: 'Wow Rate', min: 0.5, max: 3.0, default: 1.2, step: 0.1, unit: ' Hz', formatValue: (v) => `${v.toFixed(1)} Hz` },
      flutterRate: { label: 'Flutter Rate', min: 3, max: 15, default: 6.5, step: 0.1, unit: ' Hz', formatValue: (v) => `${v.toFixed(1)} Hz` },
      _trim: TRIM_PARAM,
    },
  },
  playbackAmp: {
    id: 'playbackAmp',
    label: 'Playback Amplifier',
    variants: [
      { value: 'tube', label: 'Tube' },
      { value: 'transistor', label: 'Transistor' },
    ],
    params: {
      drive: { label: 'Stage Drive', min: 0, max: 1, default: 0.4, formatValue: fmtPct },
      Vpp: { label: 'Plate V', min: 200, max: 350, default: 250, formatValue: fmtV, tubeOnly: true },
      _trim: TRIM_PARAM,
    },
  },
  playbackEQ: {
    id: 'playbackEQ',
    label: 'Playback EQ',
    variants: [
      { value: 'NAB', label: 'NAB' },
      { value: 'IEC', label: 'IEC' },
    ],
    params: {
      _trim: TRIM_PARAM,
    },
  },
  outputXfmr: {
    id: 'outputXfmr',
    label: 'Output Transformer',
    params: {
      inputGain: { label: 'Input', min: 0.25, max: 4.0, default: 1.0, step: 0.01, formatValue: fmtLinDb },
      satAmount: { label: 'Core Drive', min: 0, max: 2, default: 1.0, step: 0.01, formatValue: (v) => v.toFixed(2) },
      hfResonance: { label: 'HF Resonance', min: 5000, max: 22000, default: 20000, formatValue: fmtHz },
      hfQ: { label: 'Resonance Q', min: 0.3, max: 2.0, default: 0.7, step: 0.01, formatValue: (v) => v.toFixed(2) },
      lfCutoff: { label: 'LF Cutoff', min: 5, max: 100, default: 20, formatValue: fmtHz },
      _trim: TRIM_PARAM,
    },
  },
  noise: {
    id: 'noise',
    label: 'Tape Noise',
    params: {
      hiss: { label: 'Hiss Level', min: 0, max: 1, default: 0.05, formatValue: fmtPct },
      _trim: TRIM_PARAM,
    },
  },
  output: {
    id: 'output',
    label: 'Output',
    params: {
      outputGain: { label: 'Output Gain', min: 0.0625, max: 16, default: 1.0, formatValue: (v) => { const db = 20 * Math.log10(v); return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`; } },
    },
  },
};
