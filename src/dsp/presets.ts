import type { AmplifierStageConfig } from './amplifier';
import type { TransportProfile } from './transport';

export interface TapeFormulation {
  /** Pinning parameter (coercivity proxy). Lower = softer tape, easier saturation. */
  k: number;
  /** Reversibility baseline (before bias adjustment). */
  c: number;
  /** Inter-domain coupling. Higher = more exchange interaction. */
  alpha: number;
}

export interface MachineOperatingDefaults {
  hysteresisDrive: number;
  hysteresisSaturation: number;
  recordAmpDrive: number;
  playbackAmpDrive: number;
  bias: number;
  azimuth: number;
  weave: number;
  wow: number;
  flutter: number;
  hiss: number;
}

export interface PluginCalibration {
  /** Digital-domain output trim used at the plugin boundary, not in the physical model. */
  outputTrim: number;
}

export interface MachinePreset {
  name: string;
  eqStandard: 'NAB' | 'IEC';
  ampType: 'tube' | 'transistor';
  inputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number; asymmetry: number };
  outputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number; asymmetry: number };
  recordAmpConfig?: AmplifierStageConfig;
  playbackAmpConfig?: AmplifierStageConfig;
  defaultFormula: string;
  bumpGainDb: number;
  /** Playback head gap width in meters. */
  headGapWidth: number;
  /** Head-to-tape spacing in meters. */
  headSpacing: number;
  /** Center-to-center track spacing in meters (for azimuth delay computation). */
  trackSpacing: number;
  /** Physical track width in meters (for azimuth sinc rolloff). */
  trackWidth: number;
  transportProfile: TransportProfile;
  /** UI/operator defaults that initialize the model but are not machine specs. */
  defaults: MachineOperatingDefaults;
  /** Plugin-boundary calibration, explicitly outside the physical core. */
  plugin: PluginCalibration;
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
    recordAmpConfig: {
      sourceResistance: 24e3,
      tubeCircuit: {
        Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
        Cc_in: 33e-9, Cc_out: 150e-9, Ck: 33e-6, Vpp: 265,
      },
    },
    playbackAmpConfig: {
      sourceResistance: 100e3,
      tubeCircuit: {
        Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
        Cc_in: 18e-9, Cc_out: 82e-9, Ck: 18e-6, Vpp: 255,
      },
    },
    defaultFormula: '900',
    bumpGainDb: 2.5,
    headGapWidth: 1.5e-6,  // narrow gap, extended HF
    headSpacing: 0.5e-6,   // well-maintained, tight contact
    trackSpacing: 4.22e-3, // 1/4" 2-track NAB: 82 mil track + 84 mil guard = 166 mil c-c
    trackWidth: 2.08e-3,   // 82 mil playback track width
    transportProfile: {
      wowSupplyWeight: 0.56,
      wowTakeupWeight: 0.24,
      wowTensionWeight: 0.20,
      wowSupplyRatio: 0.84,
      wowTakeupRatio: 1.18,
      wowTensionHz: 0.65,
      reelDriftHz: 0.04,
      reelDriftDepth: 0.14,
      flutterCapstanWeight: 0.60,
      flutterPinchWeight: 0.18,
      flutterGuideWeight: 0.12,
      flutterRoughnessWeight: 0.07,
      flutterScrapeWeight: 0.03,
      flutterPinchRatio: 1.9,
      flutterGuideRatio: 1.28,
      flutterRoughnessRatio: 2.2,
      scrapeCenterHz: 720,
      scrapeBandwidthHz: 450,
    },
    defaults: {
      hysteresisDrive: 0.25,
      hysteresisSaturation: 0.35,
      recordAmpDrive: 0.18,
      playbackAmpDrive: 0.14,
      bias: 0.75,
      azimuth: 1.0,
      weave: 0.15,
      wow: 0.1,
      flutter: 0.08,
      hiss: 0.03,
    },
    plugin: {
      outputTrim: 18.3,
    },
  },
  ampex: {
    name: 'Ampex ATR-102',
    eqStandard: 'NAB',
    ampType: 'tube',
    // Jensen JT-110K-HPC — very clean, high-nickel mu-metal core
    inputTransformer: { lfCutoff: 18, hfResonance: 20000, hfQ: 1.0, satAmount: 1.2, asymmetry: 0.005 },
    outputTransformer: { lfCutoff: 15, hfResonance: 19000, hfQ: 0.9, satAmount: 1.0, asymmetry: 0.005 },
    recordAmpConfig: {
      sourceResistance: 33e3,
      tubeCircuit: {
        Rp: 220e3, Rg: 470e3, Rk: 1.8e3,
        Cc_in: 56e-9, Cc_out: 270e-9, Ck: 27e-6, Vpp: 305,
      },
    },
    playbackAmpConfig: {
      sourceResistance: 120e3,
      tubeCircuit: {
        Rp: 220e3, Rg: 470e3, Rk: 1.8e3,
        Cc_in: 39e-9, Cc_out: 180e-9, Ck: 18e-6, Vpp: 295,
      },
    },
    defaultFormula: '456',
    bumpGainDb: 3.5,
    headGapWidth: 2.0e-6,  // standard mastering head
    headSpacing: 0.8e-6,   // warm vintage character
    trackSpacing: 6.86e-3, // 1/2" 2-track: 210 mil track + 60 mil guard = 270 mil c-c
    trackWidth: 5.33e-3,   // 210 mil playback track width
    transportProfile: {
      wowSupplyWeight: 0.60,
      wowTakeupWeight: 0.25,
      wowTensionWeight: 0.15,
      wowSupplyRatio: 0.78,
      wowTakeupRatio: 1.26,
      wowTensionHz: 0.55,
      reelDriftHz: 0.035,
      reelDriftDepth: 0.12,
      flutterCapstanWeight: 0.66,
      flutterPinchWeight: 0.16,
      flutterGuideWeight: 0.10,
      flutterRoughnessWeight: 0.06,
      flutterScrapeWeight: 0.02,
      flutterPinchRatio: 1.85,
      flutterGuideRatio: 1.22,
      flutterRoughnessRatio: 2.0,
      scrapeCenterHz: 620,
      scrapeBandwidthHz: 380,
    },
    defaults: {
      hysteresisDrive: 0.35,
      hysteresisSaturation: 0.45,
      recordAmpDrive: 0.2,
      playbackAmpDrive: 0.16,
      bias: 0.75,
      azimuth: 1.5,
      weave: 0.25,
      wow: 0.12,
      flutter: 0.06,
      hiss: 0.04,
    },
    plugin: {
      outputTrim: 7.55,
    },
  },
  mci: {
    name: 'MCI JH-24',
    eqStandard: 'NAB',
    ampType: 'transistor',
    // Generic steel-core transformers — more colored, higher asymmetry
    inputTransformer: { lfCutoff: 22, hfResonance: 18000, hfQ: 0.9, satAmount: 1.1, asymmetry: 0.025 },
    outputTransformer: { lfCutoff: 20, hfResonance: 17000, hfQ: 0.8, satAmount: 0.9, asymmetry: 0.025 },
    recordAmpConfig: {
      transistor: {
        biasRecoveryMs: 35,
        biasStrength: 0.08,
        positiveSaturation: 1.25,
        negativeSaturation: 0.85,
      },
    },
    playbackAmpConfig: {
      transistor: {
        biasRecoveryMs: 90,
        biasStrength: 0.14,
        positiveSaturation: 0.9,
        negativeSaturation: 1.2,
      },
    },
    defaultFormula: '499',
    bumpGainDb: 2.0,
    headGapWidth: 4.0e-6,  // wider gap, 24-track narrow tracks
    headSpacing: 1.2e-6,   // multitrack, more wear
    trackSpacing: 2.13e-3, // 2" 24-track: 43 mil track + 41 mil guard = 84 mil c-c
    trackWidth: 1.09e-3,   // 43 mil playback track width
    transportProfile: {
      wowSupplyWeight: 0.45,
      wowTakeupWeight: 0.28,
      wowTensionWeight: 0.27,
      wowSupplyRatio: 0.74,
      wowTakeupRatio: 1.34,
      wowTensionHz: 0.9,
      reelDriftHz: 0.055,
      reelDriftDepth: 0.22,
      flutterCapstanWeight: 0.30,
      flutterPinchWeight: 0.22,
      flutterGuideWeight: 0.22,
      flutterRoughnessWeight: 0.14,
      flutterScrapeWeight: 0.12,
      flutterPinchRatio: 2.15,
      flutterGuideRatio: 1.8,
      flutterRoughnessRatio: 3.4,
      scrapeCenterHz: 1900,
      scrapeBandwidthHz: 1300,
    },
    defaults: {
      hysteresisDrive: 0.45,
      hysteresisSaturation: 0.5,
      recordAmpDrive: 0.28,
      playbackAmpDrive: 0.22,
      bias: 0.65,
      azimuth: 2.0,
      weave: 0.45,
      wow: 0.12,
      flutter: 0.08,
      hiss: 0.05,
    },
    plugin: {
      outputTrim: 35.4,
    },
  },
};
