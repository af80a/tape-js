/**
 * AudioWorklet processor that wires the full tape DSP chain.
 *
 * Runs in AudioWorkletGlobalScope where `sampleRate`, `currentTime`,
 * `AudioWorkletProcessor`, and `registerProcessor` are globals.
 */

import { HysteresisProcessor } from '../dsp/hysteresis';
import { BiasContour } from '../dsp/bias-contour';
import { WavelengthContour } from '../dsp/wavelength-contour';
import { TransformerModel } from '../dsp/transformer';
import { AmplifierModel } from '../dsp/amplifier';
import { TapeEQ } from '../dsp/eq-curves';
import { type TapeSpeed } from '../dsp/eq-curves';
import { HeadModel } from '../dsp/head-model';
import { TapeNoise } from '../dsp/noise';
import { TransportModel } from '../dsp/transport';
import { Oversampler } from '../dsp/oversampling';
import { PRESETS, FORMULAS } from '../dsp/presets';
import type { MachinePreset } from '../dsp/presets';
import { CrosstalkModel } from '../dsp/crosstalk';
import { AzimuthModel } from '../dsp/azimuth';

// ---------------------------------------------------------------------------
// High-resolution timer
// Chrome 83+ exposes performance.now() in AudioWorkletGlobalScope.
// TypeScript's audioworklet lib doesn't declare it, so we probe at runtime.
// IMPORTANT: AudioWorklet currentTime is block-quantized (constant inside one
// process() call), so it cannot be used for elapsed timing. Fall back directly
// to Date.now() when performance.now() is unavailable.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hasPerfNow = typeof (globalThis as any).performance?.now === 'function';
const _timerSource: 'perf' | 'date' = _hasPerfNow ? 'perf' : 'date';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _perfNow: () => number = _hasPerfNow
  ? () => (globalThis as any).performance.now() as number
  : () => Date.now();

// ---------------------------------------------------------------------------
// Local type declarations for AudioWorklet param descriptors
// ---------------------------------------------------------------------------

interface ParamDescriptor {
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'a-rate' | 'k-rate';
}

// Stage IDs (mirrors src/types/stages.ts but without importing to keep worklet self-contained)
type StageId =
  | 'inputXfmr' | 'recordAmp' | 'recordEQ' | 'bias' | 'hysteresis' | 'head'
  | 'transport' | 'playbackAmp' | 'playbackEQ' | 'outputXfmr' | 'noise' | 'output';

const ALL_STAGE_IDS: StageId[] = [
  'inputXfmr', 'recordAmp', 'recordEQ', 'bias', 'hysteresis', 'head',
  'transport', 'noise', 'playbackEQ', 'playbackAmp', 'outputXfmr', 'output',
];

type AmpType = 'tube' | 'transistor';
type EQStandard = 'NAB' | 'IEC';
type AmplifierStageId = 'recordAmp' | 'playbackAmp';
type EQStageId = 'recordEQ' | 'playbackEQ';
type VariantStageId = 'recordAmp' | 'playbackAmp' | 'recordEQ' | 'playbackEQ';
type RecordCouplingMode = 'delayed' | 'predictor';

const VALID_TAPE_SPEEDS: readonly TapeSpeed[] = [30, 15, 7.5, 3.75];
const MIN_COUPLING_AMOUNT = 0.25;
const MAX_COUPLING_AMOUNT = 3.0;
const COUPLING_LEVEL_MATCH_EXPONENT = 0.7;
const SATURATION_STAGE_IDS: readonly StageId[] = [
  'inputXfmr',
  'recordAmp',
  'hysteresis',
  'playbackAmp',
  'outputXfmr',
];

// ---------------------------------------------------------------------------
// Per-channel DSP state
// ---------------------------------------------------------------------------

interface ChannelDSP {
  inputXfmr: TransformerModel;
  recordAmp: AmplifierModel;
  recordEQ: TapeEQ;
  biasContour: BiasContour;
  wavelengthContour: WavelengthContour;
  hysteresis: HysteresisProcessor;
  recordOversampler: Oversampler;
  head: HeadModel;
  azimuth: AzimuthModel;
  playbackOversampler: Oversampler;
  playbackAmp: AmplifierModel;
  playbackEQ: TapeEQ;
  outputXfmr: TransformerModel;
  transport: TransportModel;
  noise: TapeNoise;
}

interface StageLevelState {
  vuPower: number[][];
  peakHold: number[][];
}

interface StageMeterSnapshot {
  vuDb: number[];
  peakDb: number[];
  saturation?: number;
}

// ---------------------------------------------------------------------------
// VU Meter ballistics constants
// ---------------------------------------------------------------------------

const VU_ATTACK_SECONDS = 0.3;
const VU_RELEASE_SECONDS = 0.55;
const PEAK_RELEASE_SECONDS = 1.1;

// ---------------------------------------------------------------------------
// TapeProcessor
// ---------------------------------------------------------------------------

class TapeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): ParamDescriptor[] {
    return [
      { name: 'inputGain',  defaultValue: 1.0,  minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'bias',       defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'drive',      defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'saturation', defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'ampDrive',  defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'wow',        defaultValue: 0.15, minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'flutter',    defaultValue: 0.1,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'hiss',       defaultValue: 0.05, minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'color',      defaultValue: 0,    minValue: -1,   maxValue: 1,   automationRate: 'k-rate' },
      { name: 'headroom',   defaultValue: 18.0, minValue: 6,    maxValue: 36,  automationRate: 'k-rate' },
      { name: 'outputGain', defaultValue: 1.0,  minValue: 0.0625, maxValue: 16.0, automationRate: 'k-rate' },
    ];
  }

  private channels: ChannelDSP[] = [];
  private alive = true;
  private bypassed = false;
  private meterFrame = 0;
  private nextMeterFrame: number;

  // Debug diagnostics — posted via port every ~1s
  private _dbgOverruns = 0;      // process() calls that exceeded budget
  private _dbgNanAmp = 0;        // NaN outputs from amp stages
  private _dbgNanHyst = 0;       // Non-finite outputs from hysteresis stage
  private _dbgOutSum = [0, 0];        // sum of final output samples (for DC)
  private _dbgOutSumSq = [0, 0];      // sum of squares (for RMS)
  private _dbgOutPeak = [0, 0];       // abs peak
  private _dbgOutCount = [0, 0];      // number of samples accumulated
  private _dbgClampHits = [0, 0];     // analog clamp activations
  private _dbgOutNonFinite = [0, 0];  // non-finite final output samples
  private _dbgMaxProcessMs = 0;  // worst process() time seen
  private _dbgTotalMs = 0;       // accumulated total process time
  private _dbgRecordMs = 0;      // accumulated record-chain time (upsample+NL+downsample)
  private _dbgPlaybackMs = 0;    // accumulated playback-chain time
  private _dbgFrameCount = 0;    // process() calls since last report
  private _dbgSampleCount = 0;   // processed samples since last report

  // Offline render progress reporting (0 when running in realtime context)
  private offlineTotalFrames = 0;
  private offlineProcessedFrames = 0;
  private offlineLastProgress = 0;

  // VU ballistics state
  private vuPower: number[] = [];
  private peakHold: number[] = [];
  private vuAttackCoeff = 0;
  private vuReleaseCoeff = 0;
  private peakReleaseCoeff = 0;

  // Per-stage metering accumulators: [channel][slot] where slot=0:input, slot=1:output
  private stageLevels: Map<StageId, StageLevelState> = new Map();

  // Per-stage saturation accumulators (smoothed 0-1 depth, only for nonlinear stages)
  private stageSaturation: Map<StageId, number[]> = new Map();

  // Per-stage trim gain (linear): Map<StageId, number>
  private stageGainLin: Map<StageId, number> = new Map();

  // Store current options for reinit
  private oversampleFactor: number;
  private tapeSpeed: TapeSpeed;
  private currentPreset: MachinePreset;
  private couplingAmount: number;
  private recordCouplingMode: RecordCouplingMode;

  // Track global overrides that should survive oversampling changes
  private currentFormula: string | null = null;

  // Per-stage variant overrides that should survive oversampling changes
  private stageVariantOverrides: Map<VariantStageId, string> = new Map();

  // Per-stage bypass map
  private stageBypassed: Map<StageId, boolean> = new Map();

  // Crossfade state for click-free bypass transitions
  private bypassFade = 0;                             // 0 = active, 1 = fully bypassed
  private stageFade: Map<StageId, number> = new Map(); // per-stage: 0 = bypassed, 1 = active
  private smoothedBias: number[] = [];                 // per-channel smoothed bias
  private static readonly CROSSFADE_SAMPLES = 128;     // ~2.7ms at 48kHz

  // Per-stage param overrides from graph view (take precedence over AudioParams)
  private stageParamOverrides: Map<string, number> = new Map();

  // Pre-allocated scratch buffer for block-level oversampling (avoids GC in audio thread)
  private renderBlockSize = 128;
  private inputBlock = new Float32Array(128);
  private sagBlocks: Float64Array[] = [];
  private pbIpBlocks: Float64Array[] = [];
  private tapeBlocks: Float32Array[] = [];
  private crosstalkInput: Float32Array[] = [];  // Pre-allocated view for crosstalk (avoids .slice() alloc)

  private crosstalk!: CrosstalkModel;

  // Inter-stage coupling state (1-sample delayed back-coupling)
  // Grid current from recordAmp loads down the input transformer output
  private delayedIg: number[] = [];
  // Tape saturation depth modulates the recordAmp's effective load impedance
  private delayedTapeSat: number[] = [];
  // Grid current from playbackAmp loads down the repro head output
  private delayedPbIg: number[] = [];
  // Output transformer saturation depth modulates playbackAmp's effective load
  private delayedOxfmrSat: number[] = [];

  // Physical coupling constants
  private static readonly XFMR_Z_OUT = 10000;        // transformer secondary impedance (ohms)
  private static readonly HEAD_Z_OUT = 15000;        // repro head output impedance (ohms)

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super();

    const opts = options?.processorOptions ?? {};
    this.currentPreset = this.resolvePreset(opts.preset);
    this.oversampleFactor = this.normalizeOversampleFactor(opts.oversample);
    this.tapeSpeed = this.normalizeTapeSpeed(opts.tapeSpeed);
    this.couplingAmount = this.normalizeCouplingAmount(opts.couplingAmount);
    this.recordCouplingMode = this.normalizeRecordCouplingMode(opts.recordCouplingMode);
    this.offlineTotalFrames = Math.max(0, (opts.totalFrames as number) ?? 0);

    // Compute VU ballistics coefficients
    this.vuAttackCoeff = Math.exp(-1 / (sampleRate * VU_ATTACK_SECONDS));
    this.vuReleaseCoeff = Math.exp(-1 / (sampleRate * VU_RELEASE_SECONDS));
    this.peakReleaseCoeff = Math.exp(-1 / (sampleRate * PEAK_RELEASE_SECONDS));

    this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);

    // Meter timing: send meter data approximately every 50 ms
    this.nextMeterFrame = Math.floor((50 / 1000) * sampleRate);

    this.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as Record<string, unknown>);
    };
  }

  private handleMessage(data: Record<string, unknown>): void {
    switch (data.type) {
      case 'set-preset':
        this.resetPresetState(data.value);
        break;
      case 'set-speed':
        this.updateTapeSpeed(data.value);
        break;
      case 'set-oversample':
        this.oversampleFactor = this.normalizeOversampleFactor(data.value);
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
        break;
      case 'set-coupling-amount':
        this.couplingAmount = this.normalizeCouplingAmount(data.value);
        break;
      case 'set-record-coupling-mode':
        this.recordCouplingMode = this.normalizeRecordCouplingMode(data.value);
        break;
      case 'set-formula':
        if (typeof data.value === 'string' && FORMULAS[data.value]) {
          this.currentFormula = data.value;
          this.applyFormula(data.value);
        }
        break;
      case 'set-bypass':
        this.bypassed = !!data.value;
        break;
      case 'clear-param-overrides':
        // CompactView changed an AudioParam — clear all overrides so AudioParams take effect.
        this.clearStageOverrides();
        break;
      case 'set-stage-bypass':
        if (this.isStageId(data.stageId)) {
          this.stageBypassed.set(data.stageId, !!data.value);
        }
        break;
      case 'set-stage-variant':
        if (this.isStageId(data.stageId) && typeof data.value === 'string') {
          this.handleVariantChange(data.stageId, data.value);
        }
        break;
      case 'set-stage-param':
        if (
          this.isStageId(data.stageId) &&
          typeof data.param === 'string' &&
          typeof data.value === 'number' &&
          Number.isFinite(data.value)
        ) {
          this.handleStageParam(data.stageId, data.param, data.value);
        }
        break;
      case 'dispose':
        this.alive = false;
        break;
    }
  }

  private resetPresetState(value: unknown): void {
    this.currentPreset = this.resolvePreset(value);
    this.currentFormula = null;
    this.stageVariantOverrides.clear();
    this.stageBypassed.clear();
    this.stageFade.clear();
    this.clearStageOverrides();
    this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
  }

  private updateTapeSpeed(value: unknown): void {
    const speed = this.normalizeTapeSpeed(value);
    this.tapeSpeed = speed;
    for (const dsp of this.channels) {
      dsp.recordEQ.setSpeed(speed);
      dsp.biasContour.setSpeed(speed);
      dsp.wavelengthContour.setSpeed(speed);
      dsp.playbackEQ.setSpeed(speed);
      dsp.head.setSpeed(speed);
      dsp.azimuth.setSpeed(speed);
    }
  }

  private isStageId(stageId: unknown): stageId is StageId {
    return typeof stageId === 'string' && (ALL_STAGE_IDS as readonly string[]).includes(stageId);
  }

  private isAmpType(value: unknown): value is AmpType {
    return value === 'tube' || value === 'transistor';
  }

  private isEqStandard(value: unknown): value is EQStandard {
    return value === 'NAB' || value === 'IEC';
  }

  private resolvePreset(value: unknown): MachinePreset {
    if (typeof value === 'string' && PRESETS[value]) {
      return PRESETS[value];
    }
    return PRESETS['studer'];
  }

  private normalizeOversampleFactor(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : 2;
    return Math.max(1, Math.min(16, Math.round(raw)));
  }

  private normalizeTapeSpeed(value: unknown): TapeSpeed {
    const speed = typeof value === 'number' ? value : 15;
    return (VALID_TAPE_SPEEDS as readonly number[]).includes(speed) ? (speed as TapeSpeed) : 15;
  }

  private normalizeCouplingAmount(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    return Math.max(MIN_COUPLING_AMOUNT, Math.min(MAX_COUPLING_AMOUNT, raw));
  }

  private normalizeRecordCouplingMode(value: unknown): RecordCouplingMode {
    return value === 'predictor' ? 'predictor' : 'delayed';
  }

  private clearStageOverrides(): void {
    this.stageParamOverrides.clear();
    for (const id of ALL_STAGE_IDS) {
      this.stageGainLin.set(id, 1.0);
    }
  }

  private buildAmplifier(stageId: AmplifierStageId, ampType: AmpType, drive: number): AmplifierModel {
    const config = stageId === 'recordAmp'
      ? this.currentPreset.recordAmpConfig
      : this.currentPreset.playbackAmpConfig;
    const circuit = ampType === 'tube' ? config?.tubeCircuit : undefined;
    return new AmplifierModel(
      ampType,
      drive,
      circuit,
      sampleRate * this.oversampleFactor,
      this.oversampleFactor,
      config,
    );
  }

  private buildEq(standard: EQStandard, mode: 'record' | 'playback'): TapeEQ {
    return new TapeEQ(
      sampleRate * this.oversampleFactor,
      standard,
      this.tapeSpeed,
      mode,
    );
  }

  private createStageLevelState(channels: number): StageLevelState {
    return {
      vuPower: Array.from({ length: channels }, () => [1e-10, 1e-10]),
      peakHold: Array.from({ length: channels }, () => [0, 0]),
    };
  }

  private initializeStageState(channels: number): void {
    this.stageLevels.clear();
    for (const id of ALL_STAGE_IDS) {
      this.stageLevels.set(id, this.createStageLevelState(channels));
      if (!this.stageGainLin.has(id)) {
        this.stageGainLin.set(id, 1.0);
      }
    }

    this.stageSaturation.clear();
    for (const id of SATURATION_STAGE_IDS) {
      this.stageSaturation.set(id, Array(channels).fill(0));
    }
  }

  private reapplyVariantOverrides(): void {
    for (const [stageId, value] of this.stageVariantOverrides.entries()) {
      this.handleVariantChange(stageId, value, false);
    }
  }

  private reapplyStageParamOverrides(): void {
    for (const [key, value] of this.stageParamOverrides.entries()) {
      const parts = key.split('.');
      if (parts.length !== 2 || !this.isStageId(parts[0])) continue;
      this.applyStageParamToDSP(parts[0], parts[1], value);
    }
  }

  private applyFormulaToTargets(
    target: Pick<ChannelDSP, 'hysteresis' | 'wavelengthContour'>,
    formulaName: string,
  ): void {
    const formula = FORMULAS[formulaName] ?? FORMULAS['456'];
    target.hysteresis.setK(formula.k);
    target.hysteresis.setBaseC(formula.c);
    target.hysteresis.setAlpha(formula.alpha);
    target.wavelengthContour.setCoercivity(formula.k);
  }

  private applyFormula(formula: string): void {
    if (!FORMULAS[formula]) return;
    for (const dsp of this.channels) {
      this.applyFormulaToTargets(dsp, formula);
    }
  }

  private rebuildAmplifierStage(stageId: AmplifierStageId, ampType: AmpType): void {
    const drive = stageId === 'recordAmp'
      ? this.currentPreset.recordAmpDrive
      : this.currentPreset.playbackAmpDrive;
    for (const dsp of this.channels) {
      if (stageId === 'recordAmp') {
        dsp.recordAmp = this.buildAmplifier(stageId, ampType, drive);
      } else {
        dsp.playbackAmp = this.buildAmplifier(stageId, ampType, drive);
      }
    }
  }

  private rebuildEqStage(stageId: EQStageId, standard: EQStandard): void {
    const mode = stageId === 'recordEQ' ? 'record' : 'playback';
    for (const dsp of this.channels) {
      if (stageId === 'recordEQ') {
        dsp.recordEQ = this.buildEq(standard, mode);
      } else {
        dsp.playbackEQ = this.buildEq(standard, mode);
      }
    }
  }

  private handleVariantChange(stageId: StageId, value: string, remember = true): void {
    if (stageId === 'recordAmp' || stageId === 'playbackAmp') {
      if (!this.isAmpType(value)) return;
      if (remember) this.stageVariantOverrides.set(stageId, value);
      this.rebuildAmplifierStage(stageId, value);
      this.reapplyStageParamOverrides();
      return;
    }

    if (stageId === 'recordEQ' || stageId === 'playbackEQ') {
      if (!this.isEqStandard(value)) return;
      if (remember) this.stageVariantOverrides.set(stageId, value);
      this.rebuildEqStage(stageId, value);
      this.reapplyStageParamOverrides();
    }
  }

  private handleStageParam(stageId: StageId, param: string, value: number): void {
    if (!Number.isFinite(value)) return;

    // Store override so process loop doesn't clobber it with AudioParam values
    this.stageParamOverrides.set(`${stageId}.${param}`, value);

    // _trim is a synthetic param — apply as dB→linear multiplier, not routed to DSP
    if (param === '_trim') {
      this.stageGainLin.set(stageId, Math.pow(10, value / 20));
      return;
    }

    this.applyStageParamToDSP(stageId, param, value);
  }

  private applyTransformerParam(transformer: TransformerModel, param: string, value: number): void {
    switch (param) {
      case 'inputGain':
        transformer.reconfigure({ inputGain: value });
        break;
      case 'satAmount':
        transformer.reconfigure({ satAmount: value });
        break;
      case 'hfResonance':
        transformer.reconfigure({ hfResonance: value });
        break;
      case 'hfQ':
        transformer.reconfigure({ hfQ: value });
        break;
      case 'lfCutoff':
        transformer.reconfigure({ lfCutoff: value });
        break;
    }
  }

  private applyAmplifierParam(amp: AmplifierModel, param: string, value: number): void {
    if (param === 'drive') amp.setDrive(value);
    else if (param === 'Vpp') amp.setVpp(value);
  }

  private applyBiasParam(dsp: ChannelDSP, param: string, value: number): void {
    if (param === 'level') {
      // Bias is applied parametrically to the hysteresis model.
      dsp.hysteresis.setBias(value);
      dsp.biasContour.setBias(value);
    } else if (param === 'frequency') {
      // Legacy no-op: additive bias oscillator path was removed.
    }
  }

  private applyHysteresisParam(dsp: ChannelDSP, param: string, value: number): void {
    if (param === 'drive') dsp.hysteresis.setDrive(value);
    else if (param === 'saturation') dsp.hysteresis.setSaturation(value);
    else if (param === 'k') dsp.hysteresis.setK(value);
    else if (param === 'c') dsp.hysteresis.setBaseC(value);
  }

  private applyHeadParam(dsp: ChannelDSP, param: string, value: number): void {
    if (param === 'bumpGainDb') dsp.head.setBumpGain(value);
    else if (param === 'dropouts') dsp.head.setDropoutIntensity(value);
    else if (param === 'crosstalk') this.crosstalk.setAmount(value);
    else if (param === 'azimuth') dsp.azimuth.setAzimuth(value);
    else if (param === 'weave') dsp.azimuth.setWeave(value);
  }

  private applyTransportParam(dsp: ChannelDSP, param: string, value: number): void {
    if (param === 'wow') dsp.transport.setWow(value);
    else if (param === 'flutter') dsp.transport.setFlutter(value);
    else if (param === 'wowRate') dsp.transport.setWowRate(value);
    else if (param === 'flutterRate') dsp.transport.setFlutterRate(value);
  }

  private applyNoiseParam(dsp: ChannelDSP, param: string, value: number): void {
    if (param === 'hiss') dsp.noise.setLevel(value);
  }

  private applyStageParamToDSP(stageId: StageId, param: string, value: number): void {
    for (const dsp of this.channels) {
      switch (stageId) {
        case 'inputXfmr':
          this.applyTransformerParam(dsp.inputXfmr, param, value);
          break;
        case 'recordAmp':
          this.applyAmplifierParam(dsp.recordAmp, param, value);
          break;
        case 'recordEQ':
          if (param === 'color') dsp.recordEQ.setColor(value);
          break;
        case 'bias':
          this.applyBiasParam(dsp, param, value);
          break;
        case 'hysteresis':
          this.applyHysteresisParam(dsp, param, value);
          break;
        case 'head':
          this.applyHeadParam(dsp, param, value);
          break;
        case 'transport':
          this.applyTransportParam(dsp, param, value);
          break;
        case 'playbackAmp':
          this.applyAmplifierParam(dsp.playbackAmp, param, value);
          break;
        case 'outputXfmr':
          this.applyTransformerParam(dsp.outputXfmr, param, value);
          break;
        case 'noise':
          this.applyNoiseParam(dsp, param, value);
          break;
        // 'output' stage: outputGain is handled via override in the process loop
        // (no per-channel DSP object to call — it's a global param)
      }
    }
  }

  private createChannelDSP(
    channel: number,
    preset: MachinePreset,
    fs: number,
    osFactor: number,
  ): ChannelDSP {
    const inputXfmr = new TransformerModel(fs * osFactor, preset.inputTransformer);
    const recordAmp = this.buildAmplifier('recordAmp', preset.ampType, preset.recordAmpDrive);
    const recordEQ = this.buildEq(preset.eqStandard, 'record');
    const biasContour = new BiasContour(fs * osFactor, this.tapeSpeed, preset.biasDefault);
    biasContour.setBias(preset.biasDefault);

    const wavelengthContour = new WavelengthContour(fs * osFactor, this.tapeSpeed, preset.headGapWidth);
    wavelengthContour.setDrive(preset.drive);
    wavelengthContour.setSaturation(preset.saturation);

    const hysteresis = new HysteresisProcessor(fs * osFactor);
    hysteresis.setDrive(preset.drive);
    hysteresis.setSaturation(preset.saturation);
    this.applyFormulaToTargets(
      { hysteresis, wavelengthContour },
      this.currentFormula ?? preset.defaultFormula,
    );

    const recordOversampler = new Oversampler(osFactor, this.renderBlockSize);
    const head = new HeadModel(fs, this.tapeSpeed, {
      gapWidth: preset.headGapWidth,
      spacing: preset.headSpacing,
      bumpGainDb: preset.bumpGainDb,
    }, channel);
    const azimuth = new AzimuthModel(
      fs,
      channel,
      this.tapeSpeed,
      preset.trackSpacing,
      preset.trackWidth,
    );
    azimuth.setAzimuth(preset.azimuthDefault);
    azimuth.setWeave(preset.azimuthWeaveDefault);

    const playbackOversampler = new Oversampler(osFactor, this.renderBlockSize);
    const playbackAmp = this.buildAmplifier('playbackAmp', preset.ampType, preset.playbackAmpDrive);
    const playbackEQ = this.buildEq(preset.eqStandard, 'playback');
    const outputXfmr = new TransformerModel(fs * osFactor, preset.outputTransformer);

    const transport = new TransportModel(fs, channel);
    transport.setWow(preset.wowDefault);
    transport.setFlutter(preset.flutterDefault);

    const noise = new TapeNoise(fs, channel);
    noise.setLevel(preset.hissDefault);

    return {
      inputXfmr,
      recordAmp,
      recordEQ,
      biasContour,
      wavelengthContour,
      hysteresis,
      recordOversampler,
      head,
      azimuth,
      playbackOversampler,
      playbackAmp,
      playbackEQ,
      outputXfmr,
      transport,
      noise,
    };
  }

  private initializeStageFades(): void {
    for (const id of ALL_STAGE_IDS) {
      this.stageFade.set(id, (this.stageBypassed.get(id) ?? false) ? 0 : 1);
    }
  }

  private initDSP(
    channels: number,
    preset: MachinePreset,
    oversampleFactor: number,
    speed: TapeSpeed,
  ): void {
    this.oversampleFactor = this.normalizeOversampleFactor(oversampleFactor);
    this.tapeSpeed = this.normalizeTapeSpeed(speed);

    const fs = sampleRate;
    const osFactor = this.oversampleFactor;
    this.inputBlock = new Float32Array(this.renderBlockSize);
    this.channels = [];
    this.sagBlocks = [];
    this.pbIpBlocks = [];
    this.tapeBlocks = [];
    this.crosstalk = new CrosstalkModel(fs);

    // Initialize VU ballistics arrays
    this.vuPower = Array(channels).fill(1e-10);
    this.peakHold = Array(channels).fill(0);
    this.initializeStageState(channels);

    const osBlockSize = this.renderBlockSize * Math.max(1, osFactor);
    for (let ch = 0; ch < channels; ch++) {
      this.channels.push(this.createChannelDSP(ch, preset, fs, osFactor));
      this.sagBlocks.push(new Float64Array(osBlockSize));
      this.pbIpBlocks.push(new Float64Array(osBlockSize));
      this.tapeBlocks.push(new Float32Array(this.renderBlockSize));
    }
    this.crosstalkInput = this.tapeBlocks.slice(0, channels);

    // Initialize crossfade state to match current bypass settings
    this.initializeStageFades();
    this.smoothedBias = Array(channels).fill(preset.biasDefault);
    this.delayedIg = Array(channels).fill(0);
    this.delayedTapeSat = Array(channels).fill(0);
    this.delayedPbIg = Array(channels).fill(0);
    this.delayedOxfmrSat = Array(channels).fill(0);

    // Re-apply global overrides
    if (this.currentFormula) this.applyFormula(this.currentFormula);
    this.reapplyVariantOverrides();

    // Re-apply specific stage parameter overrides
    this.reapplyStageParamOverrides();
  }

  private resetDebugStats(): void {
    this._dbgOverruns = 0;
    this._dbgNanAmp = 0;
    this._dbgNanHyst = 0;
    this._dbgOutSum[0] = 0; this._dbgOutSum[1] = 0;
    this._dbgOutSumSq[0] = 0; this._dbgOutSumSq[1] = 0;
    this._dbgOutPeak[0] = 0; this._dbgOutPeak[1] = 0;
    this._dbgOutCount[0] = 0; this._dbgOutCount[1] = 0;
    this._dbgClampHits[0] = 0; this._dbgClampHits[1] = 0;
    this._dbgOutNonFinite[0] = 0; this._dbgOutNonFinite[1] = 0;
    this._dbgMaxProcessMs = 0;
    this._dbgTotalMs = 0;
    this._dbgRecordMs = 0;
    this._dbgPlaybackMs = 0;
    this._dbgFrameCount = 0;
  }

  private maybePostDebugStats(blockSize: number, elapsedMs: number): void {
    const budgetMs = (blockSize / sampleRate) * 1000;
    this._dbgFrameCount++;
    this._dbgSampleCount += blockSize;
    this._dbgTotalMs += elapsedMs;
    if (elapsedMs > budgetMs) this._dbgOverruns++;
    if (elapsedMs > this._dbgMaxProcessMs) this._dbgMaxProcessMs = elapsedMs;

    if (this._dbgSampleCount < sampleRate) {
      return;
    }

    const frames = this._dbgFrameCount;
    const outRms: number[] = [];
    const outDc: number[] = [];
    const outPeak: number[] = [];
    const outClampHits: number[] = [];
    const outNonFinite: number[] = [];

    for (let ch = 0; ch < 2; ch++) {
      const count = this._dbgOutCount[ch];
      const rms = count > 0 ? Math.sqrt(this._dbgOutSumSq[ch] / count) : 0;
      const dc = count > 0 ? (this._dbgOutSum[ch] / count) : 0;
      outRms.push(+rms.toFixed(6));
      outDc.push(+dc.toFixed(6));
      outPeak.push(+this._dbgOutPeak[ch].toFixed(6));
      outClampHits.push(this._dbgClampHits[ch] | 0);
      outNonFinite.push(this._dbgOutNonFinite[ch] | 0);
    }

    const lrImbalanceDb = (outRms[0] > 0 || outRms[1] > 0)
      ? +(20 * Math.log10((outRms[0] + 1e-12) / (outRms[1] + 1e-12))).toFixed(4)
      : 0;

    this.port.postMessage({
      type: 'debug-stats',
      timerSource: _timerSource,
      overrunsPerSec: this._dbgOverruns,
      nanAmpCount: this._dbgNanAmp,
      nanHystCount: this._dbgNanHyst,
      outRms,
      outDc,
      outPeak,
      outClampHits,
      outNonFinite,
      lrImbalanceDb,
      maxProcessMs: +this._dbgMaxProcessMs.toFixed(4),
      avgProcessMs: +(this._dbgTotalMs / frames).toFixed(4),
      avgRecordMs: +(this._dbgRecordMs / frames).toFixed(4),
      avgPlaybackMs: +(this._dbgPlaybackMs / frames).toFixed(4),
      budgetMs: +budgetMs.toFixed(4),
    });

    this.resetDebugStats();
    this._dbgSampleCount -= sampleRate;
  }

  private buildStageMeterSnapshots(numChannels: number): Record<string, StageMeterSnapshot> {
    const levels: Record<string, StageMeterSnapshot> = {};

    for (const id of ALL_STAGE_IDS) {
      const stageLevels = this.stageLevels.get(id)!;
      const vuDb: number[] = [];
      const peakDb: number[] = [];

      for (let slot = 0; slot < 2; slot++) {
        let maxPower = 1e-10;
        let maxPeak = 0;
        for (let channel = 0; channel < numChannels; channel++) {
          maxPower = Math.max(maxPower, stageLevels.vuPower[channel][slot]);
          maxPeak = Math.max(maxPeak, stageLevels.peakHold[channel][slot]);
        }
        vuDb.push(Math.max(-60, Math.min(9, 10 * Math.log10(maxPower))));
        peakDb.push(Math.max(-60, Math.min(9, maxPeak > 0 ? 20 * Math.log10(maxPeak) : -60)));
      }

      levels[id] = { vuDb, peakDb };
      const saturation = this.stageSaturation.get(id);
      if (saturation !== undefined) {
        let maxSaturation = 0;
        for (let channel = 0; channel < saturation.length; channel++) {
          maxSaturation = Math.max(maxSaturation, saturation[channel]);
        }
        levels[id].saturation = maxSaturation;
      }
    }

    return levels;
  }

  private maybePostMeters(numChannels: number, blockSize: number): void {
    this.meterFrame += blockSize;
    if (this.meterFrame < this.nextMeterFrame) {
      return;
    }
    this.meterFrame -= this.nextMeterFrame;

    const vuDb: number[] = [];
    const peakDb: number[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const vu = 10 * Math.log10(Math.max(this.vuPower[ch], 1e-10));
      vuDb.push(Math.max(-20, Math.min(9, vu)));
      const pk = this.peakHold[ch] > 0 ? 20 * Math.log10(this.peakHold[ch]) : -20;
      peakDb.push(Math.max(-20, Math.min(9, pk)));
    }

    this.port.postMessage({
      type: 'meters',
      vuDb,
      peakDb,
    });

    this.port.postMessage({
      type: 'stage-meters',
      levels: this.buildStageMeterSnapshots(numChannels),
    });
  }

  private maybePostRenderProgress(blockSize: number): void {
    if (this.offlineTotalFrames <= 0) {
      return;
    }

    this.offlineProcessedFrames += blockSize;
    const progress = Math.min(1, this.offlineProcessedFrames / this.offlineTotalFrames);
    if (progress < this.offlineLastProgress + 0.01 && progress < 1) {
      return;
    }

    this.offlineLastProgress = progress;
    this.port.postMessage({
      type: 'render-progress',
      progress: +progress.toFixed(4),
    });
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const _t0 = _perfNow();

    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) {
      return this.alive;
    }

    const blockSize = input[0].length;
    if (blockSize !== this.renderBlockSize) {
      // Render quantum is normally 128, but future engines may vary it.
      // Reinitialize scratch/oversampling buffers to stay memory-safe.
      this.renderBlockSize = blockSize;
      this.initDSP(this.channels.length || 2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
    }
    const numChannels = Math.min(input.length, output.length, this.channels.length);

    // Read k-rate parameters (single value per block)
    const inputGain  = parameters['inputGain'][0];
    const biasParam  = parameters['bias'][0];
    const drive      = parameters['drive'][0];
    const saturation = parameters['saturation'][0];
    const ampDrive   = parameters['ampDrive'][0];
    const wow        = parameters['wow'][0];
    const flutter    = parameters['flutter'][0];
    const hiss       = parameters['hiss'][0];
    const color      = parameters['color'][0];
    const headroom   = parameters['headroom'][0];
    const ov = this.stageParamOverrides;
    const outputGain = ov.get('output.outputGain') ?? parameters['outputGain'][0];

    const inputBlock = this.inputBlock;
    const factor = this.oversampleFactor > 1 ? this.oversampleFactor : 1;

    // Calculate Headroom scalars (0 VU calibration)
    // More headroom → less drive (more breathing room before saturation).
    // At the default (18 dB): inScalar = 10^((36-18)/20) ≈ 7.94, identical to the
    // previous formula, so existing behaviour at default is preserved.
    // At max headroom (36 dB): inScalar = 1 (no gain, cleanest).
    // At min headroom  (6 dB): inScalar ≈ 31.6 (heaviest drive).
    const maxHeadroomDb = 36; // matches parameterDescriptors maxValue
    const inScalar  = Math.pow(10, (maxHeadroomDb - headroom) / 20);
    const outScalar = 1.0 / inScalar;

    // Cache ballistics coefficients as locals for inner loop
    const attackCoeff = this.vuAttackCoeff;
    const releaseCoeff = this.vuReleaseCoeff;
    const attackDelta = 1 - attackCoeff;
    const releaseDelta = 1 - releaseCoeff;
    const peakRelCoeff = this.peakReleaseCoeff;
    
    // Lowpass filter coefficient for 1-sample delayed coupling (prevents Nyquist oscillation).
    // A 20us time constant (~8kHz cutoff) preserves all punch while ensuring stability.
    const couplingAlpha = Math.exp(-1 / (sampleRate * factor * 0.00002));

    // Cache stage bypass flags for hot loop
    const bypassInputXfmr = this.stageBypassed.get('inputXfmr') ?? false;
    const bypassRecordAmp = this.stageBypassed.get('recordAmp') ?? false;
    const bypassRecordEQ = this.stageBypassed.get('recordEQ') ?? false;
    const bypassBias = this.stageBypassed.get('bias') ?? false;
    const bypassHysteresis = this.stageBypassed.get('hysteresis') ?? false;
    const bypassHead = this.stageBypassed.get('head') ?? false;
    const bypassTransport = this.stageBypassed.get('transport') ?? false;
    const bypassPlaybackAmp = this.stageBypassed.get('playbackAmp') ?? false;
    const bypassPlaybackEQ = this.stageBypassed.get('playbackEQ') ?? false;
    const bypassOutputXfmr = this.stageBypassed.get('outputXfmr') ?? false;
    const bypassNoise = this.stageBypassed.get('noise') ?? false;

    // Cache per-stage trim gains as locals
    const trimInputXfmr = this.stageGainLin.get('inputXfmr') ?? 1.0;
    const trimRecordAmp = this.stageGainLin.get('recordAmp') ?? 1.0;
    const trimRecordEQ = this.stageGainLin.get('recordEQ') ?? 1.0;
    const trimBias = this.stageGainLin.get('bias') ?? 1.0;
    const trimHysteresis = this.stageGainLin.get('hysteresis') ?? 1.0;
    const trimHead = this.stageGainLin.get('head') ?? 1.0;
    const trimTransport = this.stageGainLin.get('transport') ?? 1.0;
    const trimPlaybackAmp = this.stageGainLin.get('playbackAmp') ?? 1.0;
    const trimPlaybackEQ = this.stageGainLin.get('playbackEQ') ?? 1.0;
    const trimOutputXfmr = this.stageGainLin.get('outputXfmr') ?? 1.0;
    const trimNoise = this.stageGainLin.get('noise') ?? 1.0;

    // Cache per-stage level accumulators as locals
    const slInputXfmr = this.stageLevels.get('inputXfmr')!;
    const slRecordAmp = this.stageLevels.get('recordAmp')!;
    const slRecordEQ = this.stageLevels.get('recordEQ')!;
    const slBias = this.stageLevels.get('bias')!;
    const slHysteresis = this.stageLevels.get('hysteresis')!;
    const slHead = this.stageLevels.get('head')!;
    const slTransport = this.stageLevels.get('transport')!;
    const slPlaybackAmp = this.stageLevels.get('playbackAmp')!;
    const slPlaybackEQ = this.stageLevels.get('playbackEQ')!;
    const slOutputXfmr = this.stageLevels.get('outputXfmr')!;
    const slNoise = this.stageLevels.get('noise')!;
    const slOutput = this.stageLevels.get('output')!;
    const satInputXfmr = this.stageSaturation.get('inputXfmr')!;
    const satRecordAmp = this.stageSaturation.get('recordAmp')!;
    const satHysteresis = this.stageSaturation.get('hysteresis')!;
    const satPlaybackAmp = this.stageSaturation.get('playbackAmp')!;
    const satOutputXfmr = this.stageSaturation.get('outputXfmr')!;

    const updateStageMeter = (
      sl: { vuPower: number[][]; peakHold: number[][] },
      ch: number,
      slot: 0 | 1,
      sample: number,
    ): void => {
      const power = sample * sample;
      sl.vuPower[ch][slot] += (power - sl.vuPower[ch][slot]) * (power > sl.vuPower[ch][slot] ? attackDelta : releaseDelta);
      sl.peakHold[ch][slot] = Math.max(Math.abs(sample), sl.peakHold[ch][slot] * peakRelCoeff);
    };

    // Variant that accepts pre-computed average power and block peak, so the
    // oversampled stages can accumulate across the block and apply a single
    // base-rate update, keeping VU time constants independent of oversample factor.
    const updateStageMeterPwr = (
      sl: { vuPower: number[][]; peakHold: number[][] },
      ch: number,
      slot: 0 | 1,
      power: number,
      peak: number,
    ): void => {
      sl.vuPower[ch][slot] += (power - sl.vuPower[ch][slot]) * (power > sl.vuPower[ch][slot] ? attackDelta : releaseDelta);
      sl.peakHold[ch][slot] = Math.max(peak, sl.peakHold[ch][slot] * peakRelCoeff);
    };

    // Per-stage crossfade state (cached as locals for inner loop)
    const fadeStep = 1 / TapeProcessor.CROSSFADE_SAMPLES;
    let fadeInputXfmr = this.stageFade.get('inputXfmr') ?? (bypassInputXfmr ? 0 : 1);
    let fadeRecordAmp = this.stageFade.get('recordAmp') ?? (bypassRecordAmp ? 0 : 1);
    let fadeRecordEQ = this.stageFade.get('recordEQ') ?? (bypassRecordEQ ? 0 : 1);
    let fadeBias = this.stageFade.get('bias') ?? (bypassBias ? 0 : 1);
    let fadeHysteresis = this.stageFade.get('hysteresis') ?? (bypassHysteresis ? 0 : 1);
    let fadeHead = this.stageFade.get('head') ?? (bypassHead ? 0 : 1);
    let fadeTransport = this.stageFade.get('transport') ?? (bypassTransport ? 0 : 1);
    let fadeNoise = this.stageFade.get('noise') ?? (bypassNoise ? 0 : 1);
    let fadePlaybackAmp = this.stageFade.get('playbackAmp') ?? (bypassPlaybackAmp ? 0 : 1);
    let fadePlaybackEQ = this.stageFade.get('playbackEQ') ?? (bypassPlaybackEQ ? 0 : 1);
    let fadeOutputXfmr = this.stageFade.get('outputXfmr') ?? (bypassOutputXfmr ? 0 : 1);
    let bypassFade = this.bypassFade;

    // Save initial fade values so all channels get the same crossfade
    const initFadeInputXfmr = fadeInputXfmr;
    const initFadeRecordAmp = fadeRecordAmp;
    const initFadeRecordEQ = fadeRecordEQ;
    const initFadeBias = fadeBias;
    const initFadeHysteresis = fadeHysteresis;
    const initFadeHead = fadeHead;
    const initFadeTransport = fadeTransport;
    const initFadeNoise = fadeNoise;
    const initFadePlaybackAmp = fadePlaybackAmp;
    const initFadePlaybackEQ = fadePlaybackEQ;
    const initFadeOutputXfmr = fadeOutputXfmr;
    const initBypassFade = bypassFade;

    // Bias smoothing: per-sample one-pole filter to prevent clicks on bias bypass toggle
    const ovHystDrive = ov.get('hysteresis.drive');
    const ovHystSat = ov.get('hysteresis.saturation');
    const ovRecordAmpDrive = ov.get('recordAmp.drive');
    const ovRecordEQColor = ov.get('recordEQ.color');
    const ovPlaybackAmpDrive = ov.get('playbackAmp.drive');
    const ovTransportWow = ov.get('transport.wow');
    const ovTransportFlutter = ov.get('transport.flutter');
    const ovNoiseHiss = ov.get('noise.hiss');
    const targetBias = bypassBias ? 0 : (ov.get('bias.level') ?? biasParam);
    const biasSmoothCoeff = Math.exp(-1 / (sampleRate * 0.003)); // 3ms time constant

    const advanceFade = (current: number, bypassed: boolean): number => {
      const target = bypassed ? 0 : 1;
      if (current === target) return current;
      return Math.max(0, Math.min(1, current + (target > current ? fadeStep : -fadeStep)));
    };

    const delayedIg = this.delayedIg;
    const delayedTapeSat = this.delayedTapeSat;
    const delayedPbIg = this.delayedPbIg;
    const delayedOxfmrSat = this.delayedOxfmrSat;
    const smoothedBias = this.smoothedBias;
    const dbgOutSum = this._dbgOutSum;
    const dbgOutSumSq = this._dbgOutSumSq;
    const dbgOutPeak = this._dbgOutPeak;
    const dbgOutCount = this._dbgOutCount;
    const dbgClampHits = this._dbgClampHits;
    const dbgOutNonFinite = this._dbgOutNonFinite;
    const usePredictorCoupling = this.recordCouplingMode === 'predictor';
    const couplingAmount = this.couplingAmount;
    const presetOutputCalibrationGain = this.currentPreset.outputCalibrationGain;
    // Dev audition helper: keep coupling sweeps closer in loudness so the
    // listener can judge interaction character rather than obvious gain loss.
    // This is intentionally a static output makeup, not part of the physical model.
    const couplingMakeup = Math.pow(couplingAmount, COUPLING_LEVEL_MATCH_EXPONENT);

    const _tRecord = _perfNow();
    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];

      // Restore fades for stereo coherence (each channel gets same crossfade)
      if (ch > 0) {
        fadeInputXfmr = initFadeInputXfmr;
        fadeRecordAmp = initFadeRecordAmp;
        fadeRecordEQ = initFadeRecordEQ;
        fadeBias = initFadeBias;
        fadeHysteresis = initFadeHysteresis;
      }

      // Update DSP modules with current parameter values (always, even when bypassed,
      // to keep internal state in sync with UI for click-free un-bypass).
      // Stage param overrides (from graph view) take precedence over AudioParams.
      // Bias is modeled parametrically: the bias knob controls the hysteresis
      // reversibility (c parameter) rather than generating an ultrasonic carrier.
      // This avoids aliasing artifacts from the bias frequency at achievable
      // sample rates and is physically equivalent to the effect of AC bias
      // on the tape magnetization process.
      dsp.hysteresis.setDrive(ovHystDrive ?? drive);
      dsp.hysteresis.setSaturation(ovHystSat ?? saturation);
      dsp.wavelengthContour.setDrive(ovHystDrive ?? drive);
      dsp.wavelengthContour.setSaturation(ovHystSat ?? saturation);
      dsp.recordAmp.setDrive(ovRecordAmpDrive ?? ampDrive);
      dsp.recordEQ.setColor(ovRecordEQColor ?? color);
      dsp.playbackAmp.setDrive(ovPlaybackAmpDrive ?? ampDrive * 0.8);
      dsp.transport.setWow(ovTransportWow ?? wow);
      dsp.transport.setFlutter(ovTransportFlutter ?? flutter);
      dsp.noise.setLevel(ovNoiseHiss ?? hiss);

      // ---- INPUT PREPARATION (base rate) ----
      for (let i = 0; i < blockSize; i++) {
        // Apply input gain and convert from digital dBFS to analog 0 VU reference level
        const analogIn = inp[i] * inputGain * inScalar;
        inputBlock[i] = analogIn;
        updateStageMeter(slInputXfmr, ch, 0, analogIn);
      }

      // ---- PHASE 1: RECORD CHAIN (block oversampled) ----
      const recUpsampled = dsp.recordOversampler.upsample(inputBlock);
      const recOsLen = blockSize * factor;
      const ooF = 1 / factor;

      let p0 = 0, k0 = 0, p1 = 0, k1 = 0, p2 = 0, k2 = 0, pBias = 0, kBias = 0, p3 = 0, k3 = 0;
      let maxSatInputXfmr = 0, maxSatRecordAmp = 0, maxSatHysteresis = 0;

      // Tape impedance loading responds to the saturation envelope, not individual
      // audio cycles. Fixed per block (2.67ms at 48kHz) — saturation level barely
      // changes within one block, so this is physically equivalent to per-sample.
      // Avoids 512 initStateSpace() calls/block for tube amps at 8x OS.
      const effectiveTapeSat = Math.min(1, delayedTapeSat[ch] * couplingAmount);
      const targetRload = 1e6 * (1.0 - effectiveTapeSat * 0.99) + 10000;

      for (let j = 0; j < recOsLen; j++) {
        // Bias smoothing at base-rate boundaries
        if (j % factor === 0) {
          smoothedBias[ch] += (targetBias - smoothedBias[ch]) * (1 - biasSmoothCoeff);
          dsp.hysteresis.setBias(smoothedBias[ch]);
          dsp.biasContour.setBias(smoothedBias[ch]);
        }

        let v = recUpsampled[j];

        // inputXfmr → recordAmp grid current loads the transformer output.
        // Default path uses the previous sample's smoothed grid current to keep
        // the inter-stage loop causal. Predictor mode estimates same-sample Ig
        // with a side-effect-free amp preview, then applies one correction pass.
        const dryXfmr = v;
        const unloadedXfmr = dsp.inputXfmr.process(v) * trimInputXfmr;
        let xfmrOut = unloadedXfmr;
        if (usePredictorCoupling) {
          const predictedIg = dsp.recordAmp.previewGridCurrent(unloadedXfmr, this.pbIpBlocks[ch][j], targetRload);
          if (Number.isFinite(predictedIg)) {
            xfmrOut -= Math.max(0, predictedIg) * TapeProcessor.XFMR_Z_OUT * couplingAmount;
          }
        } else {
          xfmrOut -= delayedIg[ch] * TapeProcessor.XFMR_Z_OUT * couplingAmount;
        }
        maxSatInputXfmr = Math.max(maxSatInputXfmr, dsp.inputXfmr.getSaturationDepth());
        v = dryXfmr + (xfmrOut - dryXfmr) * fadeInputXfmr;
        p0 += v * v; k0 = Math.max(k0, Math.abs(v));

        // recordAmp → tape saturation loads the amp output (1-sample delayed)
        const dryRamp = v;
        // Physical impedance loading: when tape core saturates, impedance drops from 1M to ~10k
        const targetPbIp = this.pbIpBlocks[ch][j];
        v = dsp.recordAmp.process(v, targetPbIp, targetRload) * trimRecordAmp;
        if (!Number.isFinite(v)) { this._dbgNanAmp++; v = 0; }
        maxSatRecordAmp = Math.max(maxSatRecordAmp, dsp.recordAmp.getSaturationDepth());
        
        this.sagBlocks[ch][j] = dsp.recordAmp.getScreenVoltage();
        
        // Update grid current coupling with low-pass smoothing to prevent Nyquist oscillation
        const targetIg = dsp.recordAmp.getGridCurrent();
        delayedIg[ch] = delayedIg[ch] * couplingAlpha + targetIg * (1 - couplingAlpha);
        
        v = dryRamp + (v - dryRamp) * fadeRecordAmp;
        p1 += v * v; k1 = Math.max(k1, Math.abs(v));

        const dryReq = v;
        v = dsp.recordEQ.process(v) * trimRecordEQ;
        v = dryReq + (v - dryReq) * fadeRecordEQ;
        p2 += v * v; k2 = Math.max(k2, Math.abs(v));

        const dryBias = v;
        v = dsp.biasContour.process(v) * trimBias;
        v = dryBias + (v - dryBias) * fadeBias;
        pBias += v * v; kBias = Math.max(kBias, Math.abs(v));

        // hysteresis → update delayed tape saturation for next sample's amp loading
        const dryHyst = v;
        v = dsp.wavelengthContour.process(v);
        v = dsp.hysteresis.process(v) * trimHysteresis;
        if (!Number.isFinite(v)) { this._dbgNanHyst++; v = 0; }
        const satH = dsp.hysteresis.getSaturationDepth();
        maxSatHysteresis = Math.max(maxSatHysteresis, satH);
        
        // Update tape saturation coupling with low-pass smoothing
        delayedTapeSat[ch] = delayedTapeSat[ch] * couplingAlpha + satH * (1 - couplingAlpha);
        
        v = dryHyst + (v - dryHyst) * fadeHysteresis;
        p3 += v * v; k3 = Math.max(k3, Math.abs(v));

        recUpsampled[j] = v;

        // Per-base-rate-sample: update meters, saturation, fades, reset sub-accumulators
        if ((j + 1) % factor === 0) {
          updateStageMeterPwr(slInputXfmr,  ch, 1, p0 * ooF, k0);
          updateStageMeterPwr(slRecordAmp,  ch, 0, p0 * ooF, k0);
          updateStageMeterPwr(slRecordAmp,  ch, 1, p1 * ooF, k1);
          updateStageMeterPwr(slRecordEQ,   ch, 0, p1 * ooF, k1);
          updateStageMeterPwr(slRecordEQ,   ch, 1, p2 * ooF, k2);
          updateStageMeterPwr(slBias,       ch, 0, p2 * ooF, k2);
          updateStageMeterPwr(slBias,       ch, 1, pBias * ooF, kBias);
          updateStageMeterPwr(slHysteresis, ch, 0, pBias * ooF, kBias);
          updateStageMeterPwr(slHysteresis, ch, 1, p3 * ooF, k3);

          const msi = maxSatInputXfmr * fadeInputXfmr;
          satInputXfmr[ch] += (msi - satInputXfmr[ch]) * (msi > satInputXfmr[ch] ? attackDelta : releaseDelta);

          const msr = maxSatRecordAmp * fadeRecordAmp;
          satRecordAmp[ch] += (msr - satRecordAmp[ch]) * (msr > satRecordAmp[ch] ? attackDelta : releaseDelta);

          const msh = maxSatHysteresis * fadeHysteresis;
          satHysteresis[ch] += (msh - satHysteresis[ch]) * (msh > satHysteresis[ch] ? attackDelta : releaseDelta);

          fadeInputXfmr = advanceFade(fadeInputXfmr, bypassInputXfmr);
          fadeRecordAmp = advanceFade(fadeRecordAmp, bypassRecordAmp);
          fadeRecordEQ = advanceFade(fadeRecordEQ, bypassRecordEQ);
          fadeBias = advanceFade(fadeBias, bypassBias);
          fadeHysteresis = advanceFade(fadeHysteresis, bypassHysteresis);

          p0 = 0; k0 = 0; p1 = 0; k1 = 0; p2 = 0; k2 = 0; pBias = 0; kBias = 0; p3 = 0; k3 = 0;
          maxSatInputXfmr = 0; maxSatRecordAmp = 0; maxSatHysteresis = 0;
        }
      }

      const tapeBlock = dsp.recordOversampler.downsample(recUpsampled);
      this.tapeBlocks[ch].set(tapeBlock);
    }

    // Process magnetic crosstalk between channels
    if (numChannels > 1) {
      this.crosstalk.process(this.crosstalkInput);
    }
    this._dbgRecordMs += _perfNow() - _tRecord;

    const _tPlayback = _perfNow();
    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];
      const out = output[ch];
      const tapeBlock = this.tapeBlocks[ch];

      // Restore fades for stereo coherence (each channel gets same crossfade)
      if (ch > 0) {
        fadeHead = initFadeHead;
        fadeTransport = initFadeTransport;
        fadeNoise = initFadeNoise;
        fadePlaybackAmp = initFadePlaybackAmp;
        fadePlaybackEQ = initFadePlaybackEQ;
        fadeOutputXfmr = initFadeOutputXfmr;
        bypassFade = initBypassFade;
      }

      // ---- PHASE 2: BASE-RATE TAPE (noise, head, transport) ----
      for (let i = 0; i < blockSize; i++) {
        let x = tapeBlock[i];

        // Tape noise belongs on the tape path, not after transport. Putting it
        // here lets head loss, azimuth, and wow/flutter act on hiss as well.
        updateStageMeter(slNoise, ch, 0, x);
        const dryNoise = x;
        x = (x + dsp.noise.process(Math.abs(x))) * trimNoise;
        x = dryNoise + (x - dryNoise) * fadeNoise;
        updateStageMeter(slNoise, ch, 1, x);

        updateStageMeter(slHead, ch, 0, x);
        const dryHead = x;
        x = dsp.azimuth.process(dsp.head.process(x)) * trimHead;
        x = dryHead + (x - dryHead) * fadeHead;
        updateStageMeter(slHead, ch, 1, x);

        updateStageMeter(slTransport, ch, 0, x);
        const dryTransport = x;
        x = dsp.transport.process(x) * trimTransport;
        x = dryTransport + (x - dryTransport) * fadeTransport;
        updateStageMeter(slTransport, ch, 1, x);

        tapeBlock[i] = x;

        fadeNoise = advanceFade(fadeNoise, bypassNoise);
        fadeHead = advanceFade(fadeHead, bypassHead);
        fadeTransport = advanceFade(fadeTransport, bypassTransport);
      }

      // ---- PHASE 3: PLAYBACK CHAIN (block oversampled) ----
      for (let i = 0; i < blockSize; i++) {
        updateStageMeter(slPlaybackEQ, ch, 0, tapeBlock[i]);
      }

      const pbUpsampled = dsp.playbackOversampler.upsample(tapeBlock);
      const pbOsLen = blockSize * factor;
      const ooF = 1 / factor;

      let pb0 = 0, pk0 = 0, pb1 = 0, pk1 = 0, pb2 = 0, pk2 = 0;
      let maxSatPlaybackAmp = 0, maxSatOutputXfmr = 0;

      // Same reasoning: output transformer loading fixed per block.
      const effectiveOutputSat = Math.min(1, delayedOxfmrSat[ch] * couplingAmount);
      const targetOxfmrRload = 1e6 * (1.0 - effectiveOutputSat * 0.99) + 10000;

      for (let j = 0; j < pbOsLen; j++) {

        let v = pbUpsampled[j];

        // Repro Head → Playback EQ (Clean preamp stage)
        const dryPeq = v;
        v = dsp.playbackEQ.process(v) * trimPlaybackEQ;
        v = dryPeq + (v - dryPeq) * fadePlaybackEQ;
        pb0 += v * v; pk0 = Math.max(pk0, Math.abs(v));

        // Shared power supply: record amp sag propagates to playback amp
        const sharedSagV = this.sagBlocks[ch][j];
        if (sharedSagV > 0) dsp.playbackAmp.setSagVoltage(sharedSagV);

        // PlaybackEQ → playbackAmp grid current loads the repro chain output.
        // Predictor mode mirrors the record-side corrector: estimate same-sample
        // grid current against the current shared sag and block-held output
        // transformer load, then apply one correction pass.
        if (usePredictorCoupling) {
          const predictedPbIg = dsp.playbackAmp.previewGridCurrent(v, 0, targetOxfmrRload);
          if (Number.isFinite(predictedPbIg)) {
            v -= Math.max(0, predictedPbIg) * TapeProcessor.HEAD_Z_OUT * couplingAmount;
          }
        } else {
          // Playback EQ → Playback Amp Grid loading (1-sample delayed)
          // Grid current spikes from the amp drag down the EQ's output voltage.
          v -= delayedPbIg[ch] * TapeProcessor.HEAD_Z_OUT * couplingAmount;
        }

        const dryPamp = v;
        // Playback Amp → Output Transformer loading (1-sample delayed)
        // Physical impedance loading: transformer core saturation drops primary inductance, crashing load impedance
        v = dsp.playbackAmp.process(v, 0, targetOxfmrRload) * trimPlaybackAmp;
        if (!Number.isFinite(v)) { this._dbgNanAmp++; v = 0; }
        maxSatPlaybackAmp = Math.max(maxSatPlaybackAmp, dsp.playbackAmp.getSaturationDepth());
        
        this.pbIpBlocks[ch][j] = dsp.playbackAmp.getPlateCurrent();
        
        // Update playback grid current coupling with low-pass smoothing
        const targetPbIg = dsp.playbackAmp.getGridCurrent();
        delayedPbIg[ch] = delayedPbIg[ch] * couplingAlpha + targetPbIg * (1 - couplingAlpha);
        
        v = dryPamp + (v - dryPamp) * fadePlaybackAmp;
        pb1 += v * v; pk1 = Math.max(pk1, Math.abs(v));

        const dryOxfmr = v;
        v = dsp.outputXfmr.process(v) * trimOutputXfmr;
        const satO = dsp.outputXfmr.getSaturationDepth();
        maxSatOutputXfmr = Math.max(maxSatOutputXfmr, satO);
        
        // Update output transformer saturation coupling with low-pass smoothing
        delayedOxfmrSat[ch] = delayedOxfmrSat[ch] * couplingAlpha + satO * (1 - couplingAlpha);
        
        v = dryOxfmr + (v - dryOxfmr) * fadeOutputXfmr;
        pb2 += v * v; pk2 = Math.max(pk2, Math.abs(v));

        pbUpsampled[j] = v;

        // Per-base-rate-sample: update meters, saturation, fades, reset sub-accumulators
        if ((j + 1) % factor === 0) {
          updateStageMeterPwr(slPlaybackEQ,   ch, 1, pb0 * ooF, pk0);
          updateStageMeterPwr(slPlaybackAmp,  ch, 0, pb0 * ooF, pk0);
          updateStageMeterPwr(slPlaybackAmp,  ch, 1, pb1 * ooF, pk1);
          updateStageMeterPwr(slOutputXfmr,   ch, 0, pb1 * ooF, pk1);
          updateStageMeterPwr(slOutputXfmr,   ch, 1, pb2 * ooF, pk2);

          const msp = maxSatPlaybackAmp * fadePlaybackAmp;
          satPlaybackAmp[ch] += (msp - satPlaybackAmp[ch]) * (msp > satPlaybackAmp[ch] ? attackDelta : releaseDelta);

          const mso = maxSatOutputXfmr * fadeOutputXfmr;
          satOutputXfmr[ch] += (mso - satOutputXfmr[ch]) * (mso > satOutputXfmr[ch] ? attackDelta : releaseDelta);

          fadePlaybackAmp = advanceFade(fadePlaybackAmp, bypassPlaybackAmp);
          fadePlaybackEQ = advanceFade(fadePlaybackEQ, bypassPlaybackEQ);
          fadeOutputXfmr = advanceFade(fadeOutputXfmr, bypassOutputXfmr);

          pb0 = 0; pk0 = 0; pb1 = 0; pk1 = 0; pb2 = 0; pk2 = 0;
          maxSatPlaybackAmp = 0; maxSatOutputXfmr = 0;
        }
      }

      const outputBlock = dsp.playbackOversampler.downsample(pbUpsampled);

      // ---- PHASE 4: OUTPUT + VU METERING (base rate) ----
      for (let i = 0; i < blockSize; i++) {
        let x = outputBlock[i];

        if (!Number.isFinite(x)) x = 0;
        // Safety clamp scaled to headroom so the ceiling stays at +6 dBFS in the
        // digital domain regardless of the analog operating level.
        const analogClamp = 2 * inScalar;
        let clamped = false;
        if (x > analogClamp) { x = analogClamp; clamped = true; }
        else if (x < -analogClamp) { x = -analogClamp; clamped = true; }
        if (clamped && ch < 2) dbgClampHits[ch]++;

        // x is at analog levels. Apply output gain.
        const analogOut = x * presetOutputCalibrationGain * outputGain * couplingMakeup;
        updateStageMeter(slOutput, ch, 0, analogOut);

        const globalTarget = this.bypassed ? 1 : 0;
        if (bypassFade !== globalTarget) {
          bypassFade += globalTarget > bypassFade ? fadeStep : -fadeStep;
          bypassFade = Math.max(0, Math.min(1, bypassFade));
        }

        // Convert analog back to digital, applying global bypass crossfade
        const digitalOut = analogOut * outScalar;
        let finalOut = inp[i] * bypassFade + digitalOut * (1 - bypassFade);
        if (!Number.isFinite(finalOut)) {
          if (ch < 2) dbgOutNonFinite[ch]++;
          finalOut = 0;
        }
        out[i] = finalOut;
        if (ch < 2) {
          dbgOutSum[ch] += finalOut;
          dbgOutSumSq[ch] += finalOut * finalOut;
          const absOut = Math.abs(finalOut);
          if (absOut > dbgOutPeak[ch]) dbgOutPeak[ch] = absOut;
          dbgOutCount[ch]++;
        }

        // Meter the analog signal so the UI VU meter reads correctly around 0 VU
        updateStageMeter(slOutput, ch, 1, analogOut);

        const power = analogOut * analogOut;
        const vuCoeff = power > this.vuPower[ch] ? attackCoeff : releaseCoeff;
        this.vuPower[ch] = vuCoeff * this.vuPower[ch] + (1 - vuCoeff) * power;
        this.peakHold[ch] = Math.max(Math.abs(analogOut), this.peakHold[ch] * peakRelCoeff);
      }
    }

    // If graph input is mono but worklet output is stereo, duplicate processed
    // channel 0 to remaining outputs so image stays centered and deterministic.
    if (numChannels === 1 && output.length > 1) {
      const left = output[0];
      for (let ch = 1; ch < output.length; ch++) {
        output[ch].set(left);
      }
    }

    this._dbgPlaybackMs += _perfNow() - _tPlayback;

    // Store crossfade state back
    this.stageFade.set('inputXfmr', fadeInputXfmr);
    this.stageFade.set('recordAmp', fadeRecordAmp);
    this.stageFade.set('recordEQ', fadeRecordEQ);
    this.stageFade.set('bias', fadeBias);
    this.stageFade.set('hysteresis', fadeHysteresis);
    this.stageFade.set('head', fadeHead);
    this.stageFade.set('transport', fadeTransport);
    this.stageFade.set('noise', fadeNoise);
    this.stageFade.set('playbackAmp', fadePlaybackAmp);
    this.stageFade.set('playbackEQ', fadePlaybackEQ);
    this.stageFade.set('outputXfmr', fadeOutputXfmr);
    this.bypassFade = bypassFade;

    this.maybePostDebugStats(blockSize, _perfNow() - _t0);
    this.maybePostMeters(numChannels, blockSize);
    this.maybePostRenderProgress(blockSize);

    return this.alive;
  }
}

registerProcessor('tape-processor', TapeProcessor);
