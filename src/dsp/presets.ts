export interface MachinePreset {
  name: string;
  eqStandard: 'NAB' | 'IEC';
  ampType: 'tube' | 'transistor';
  inputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number };
  outputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number };
  drive: number;
  saturation: number;
  biasDefault: number;
  bumpGainDb: number;
  wowDefault: number;
  flutterDefault: number;
  hissDefault: number;
}

export const PRESETS: Record<string, MachinePreset> = {
  studer: {
    name: 'Studer A810',
    eqStandard: 'IEC',
    ampType: 'tube',
    inputTransformer: { lfCutoff: 15, hfResonance: 55000, hfQ: 0.7, satAmount: 0.8 },
    outputTransformer: { lfCutoff: 12, hfResonance: 50000, hfQ: 0.6, satAmount: 0.7 },
    drive: 0.4,
    saturation: 0.5,
    biasDefault: 0.5,
    bumpGainDb: 2.5,
    wowDefault: 0.1,
    flutterDefault: 0.08,
    hissDefault: 0.03,
  },
  ampex: {
    name: 'Ampex ATR-102',
    eqStandard: 'NAB',
    ampType: 'tube',
    inputTransformer: { lfCutoff: 20, hfResonance: 40000, hfQ: 1.0, satAmount: 1.2 },
    outputTransformer: { lfCutoff: 18, hfResonance: 38000, hfQ: 0.9, satAmount: 1.0 },
    drive: 0.5,
    saturation: 0.6,
    biasDefault: 0.55,
    bumpGainDb: 3.5,
    wowDefault: 0.12,
    flutterDefault: 0.06,
    hissDefault: 0.04,
  },
  mci: {
    name: 'MCI JH-24',
    eqStandard: 'NAB',
    ampType: 'transistor',
    inputTransformer: { lfCutoff: 25, hfResonance: 45000, hfQ: 0.9, satAmount: 1.1 },
    outputTransformer: { lfCutoff: 22, hfResonance: 42000, hfQ: 0.8, satAmount: 0.9 },
    drive: 0.55,
    saturation: 0.55,
    biasDefault: 0.48,
    bumpGainDb: 2.0,
    wowDefault: 0.15,
    flutterDefault: 0.1,
    hissDefault: 0.05,
  },
};
