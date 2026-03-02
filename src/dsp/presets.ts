import type { TubeCircuitParams } from './amplifier';

export interface TapeFormulation {
  /** Pinning parameter (coercivity proxy). Lower = softer tape, easier saturation. */
  k: number;
  /** Reversibility baseline (before bias adjustment). */
  c: number;
  /** Inter-domain coupling. Higher = more exchange interaction. */
  alpha: number;
}

export interface MachinePreset {
  name: string;
  eqStandard: 'NAB' | 'IEC';
  ampType: 'tube' | 'transistor';
  inputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number; asymmetry: number };
  outputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number; asymmetry: number };
  tubeCircuit?: TubeCircuitParams;
  /** Tape stock magnetic properties. */
  tapeFormulation: TapeFormulation;
  drive: number;
  saturation: number;
  recordAmpDrive: number;
  playbackAmpDrive: number;
  biasDefault: number;
  bumpGainDb: number;
  /** Playback head gap width in meters. */
  headGapWidth: number;
  /** Head-to-tape spacing in meters. */
  headSpacing: number;
  wowDefault: number;
  flutterDefault: number;
  hissDefault: number;
}

export const PRESETS: Record<string, MachinePreset> = {
  studer: {
    name: 'Studer A810',
    eqStandard: 'IEC',
    ampType: 'tube',
    // Haufe RK378 — moderate core asymmetry, clean nickel core
    inputTransformer: { lfCutoff: 12, hfResonance: 21000, hfQ: 0.7, satAmount: 0.8, asymmetry: 0.015 },
    outputTransformer: { lfCutoff: 10, hfResonance: 20000, hfQ: 0.6, satAmount: 0.7, asymmetry: 0.015 },
    tubeCircuit: {
      Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
      Cc_in: 22e-9, Cc_out: 100e-9, Ck: 25e-6, Vpp: 250,
    },
    // Quantegy GP9 — modern formulation, extended headroom
    tapeFormulation: { k: 0.55, c: 0.1, alpha: 1.6e-3 },
    drive: 0.4,
    saturation: 0.5,
    recordAmpDrive: 0.5,
    playbackAmpDrive: 0.4,
    biasDefault: 0.5,
    bumpGainDb: 2.5,
    headGapWidth: 1.5e-6,  // narrow gap, extended HF
    headSpacing: 0.5e-6,   // well-maintained, tight contact
    wowDefault: 0.1,
    flutterDefault: 0.08,
    hissDefault: 0.03,
  },
  ampex: {
    name: 'Ampex ATR-102',
    eqStandard: 'NAB',
    ampType: 'tube',
    // Jensen JT-110K-HPC — very clean, high-nickel mu-metal core
    inputTransformer: { lfCutoff: 18, hfResonance: 20000, hfQ: 1.0, satAmount: 1.2, asymmetry: 0.005 },
    outputTransformer: { lfCutoff: 15, hfResonance: 19000, hfQ: 0.9, satAmount: 1.0, asymmetry: 0.005 },
    tubeCircuit: {
      Rp: 220e3, Rg: 470e3, Rk: 1.8e3,
      Cc_in: 47e-9, Cc_out: 220e-9, Ck: 22e-6, Vpp: 300,
    },
    // Ampex 456 — classic 1970s formulation, warm saturation
    tapeFormulation: { k: 0.47, c: 0.1, alpha: 1.8e-3 },
    drive: 0.5,
    saturation: 0.6,
    recordAmpDrive: 0.6,
    playbackAmpDrive: 0.45,
    biasDefault: 0.55,
    bumpGainDb: 3.5,
    headGapWidth: 2.0e-6,  // standard mastering head
    headSpacing: 0.8e-6,   // warm vintage character
    wowDefault: 0.12,
    flutterDefault: 0.06,
    hissDefault: 0.04,
  },
  mci: {
    name: 'MCI JH-24',
    eqStandard: 'NAB',
    ampType: 'transistor',
    // Generic steel-core transformers — more colored, higher asymmetry
    inputTransformer: { lfCutoff: 22, hfResonance: 18000, hfQ: 0.9, satAmount: 1.1, asymmetry: 0.025 },
    outputTransformer: { lfCutoff: 20, hfResonance: 17000, hfQ: 0.8, satAmount: 0.9, asymmetry: 0.025 },
    // Mixed stock — middle-ground formulation
    tapeFormulation: { k: 0.50, c: 0.1, alpha: 1.5e-3 },
    drive: 0.55,
    saturation: 0.55,
    recordAmpDrive: 0.55,
    playbackAmpDrive: 0.4,
    biasDefault: 0.48,
    bumpGainDb: 2.0,
    headGapWidth: 4.0e-6,  // wider gap, 24-track narrow tracks
    headSpacing: 1.2e-6,   // multitrack, more wear
    wowDefault: 0.15,
    flutterDefault: 0.1,
    hissDefault: 0.05,
  },
};
