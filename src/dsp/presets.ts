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
  defaultFormula: string;
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
  /** Center-to-center track spacing in meters (for azimuth delay computation). */
  trackSpacing: number;
  /** Default azimuth error in arcminutes (0 = perfect alignment). */
  azimuthDefault: number;
  wowDefault: number;
  flutterDefault: number;
  hissDefault: number;
  outputCalibrationGain: number;
}

export const FORMULAS: Record<string, TapeFormulation> = {
  '456': { k: 0.47, c: 0.1, alpha: 1.8e-3 },  // Ampex 456
  '499': { k: 0.55, c: 0.15, alpha: 1.0e-3 }, // Quantegy 499
  '900': { k: 0.50, c: 0.05, alpha: 2.5e-3 }, // BASF 900
};

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
    defaultFormula: '900',
    drive: 0.25,
    saturation: 0.35,
    recordAmpDrive: 0.18,
    playbackAmpDrive: 0.14,
    biasDefault: 0.75,
    bumpGainDb: 2.5,
    headGapWidth: 1.5e-6,  // narrow gap, extended HF
    headSpacing: 0.5e-6,   // well-maintained, tight contact
    trackSpacing: 4.22e-3, // 1/4" 2-track NAB: 82 mil track + 84 mil guard = 166 mil c-c
    azimuthDefault: 1.0,   // well-calibrated Swiss precision
    wowDefault: 0.1,
    flutterDefault: 0.08,
    hissDefault: 0.03,
    outputCalibrationGain: 18.3,
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
    defaultFormula: '456',
    drive: 0.35,
    saturation: 0.45,
    recordAmpDrive: 0.2,
    playbackAmpDrive: 0.16,
    biasDefault: 0.75,
    bumpGainDb: 3.5,
    headGapWidth: 2.0e-6,  // standard mastering head
    headSpacing: 0.8e-6,   // warm vintage character
    trackSpacing: 6.86e-3, // 1/2" 2-track: 210 mil track + 60 mil guard = 270 mil c-c
    azimuthDefault: 1.5,   // wider format, more sensitive to alignment
    wowDefault: 0.12,
    flutterDefault: 0.06,
    hissDefault: 0.04,
    outputCalibrationGain: 7.4,
  },
  mci: {
    name: 'MCI JH-24',
    eqStandard: 'NAB',
    ampType: 'transistor',
    // Generic steel-core transformers — more colored, higher asymmetry
    inputTransformer: { lfCutoff: 22, hfResonance: 18000, hfQ: 0.9, satAmount: 1.1, asymmetry: 0.025 },
    outputTransformer: { lfCutoff: 20, hfResonance: 17000, hfQ: 0.8, satAmount: 0.9, asymmetry: 0.025 },
    defaultFormula: '499',
    drive: 0.45,
    saturation: 0.5,
    recordAmpDrive: 0.28,
    playbackAmpDrive: 0.22,
    biasDefault: 0.65,
    bumpGainDb: 2.0,
    headGapWidth: 4.0e-6,  // wider gap, 24-track narrow tracks
    headSpacing: 1.2e-6,   // multitrack, more wear
    trackSpacing: 2.13e-3, // 2" 24-track: 43 mil track + 41 mil guard = 84 mil c-c
    azimuthDefault: 2.0,   // 24-track head, harder to align precisely
    wowDefault: 0.12,
    flutterDefault: 0.08,
    hissDefault: 0.05,
    outputCalibrationGain: 35.4,
  },
};
