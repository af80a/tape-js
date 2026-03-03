/**
 * AudioWorklet processor that wires the full tape DSP chain.
 *
 * Runs in AudioWorkletGlobalScope where `sampleRate`, `currentTime`,
 * `AudioWorkletProcessor`, and `registerProcessor` are globals.
 */

import { HysteresisProcessor } from '../dsp/hysteresis';
import { TransformerModel } from '../dsp/transformer';
import { AmplifierModel } from '../dsp/amplifier';
import { TapeEQ } from '../dsp/eq-curves';
import { type TapeSpeed } from '../dsp/eq-curves';
import { HeadModel } from '../dsp/head-model';
import { TapeNoise } from '../dsp/noise';
import { TransportModel } from '../dsp/transport';
import { Oversampler } from '../dsp/oversampling';
import { PRESETS } from '../dsp/presets';
import type { MachinePreset } from '../dsp/presets';

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
  'transport', 'noise', 'playbackAmp', 'playbackEQ', 'outputXfmr', 'output',
];

// ---------------------------------------------------------------------------
// Per-channel DSP state
// ---------------------------------------------------------------------------

interface ChannelDSP {
  inputXfmr: TransformerModel;
  recordAmp: AmplifierModel;
  recordEQ: TapeEQ;
  hysteresis: HysteresisProcessor;
  recordOversampler: Oversampler;
  head: HeadModel;
  playbackOversampler: Oversampler;
  playbackAmp: AmplifierModel;
  playbackEQ: TapeEQ;
  outputXfmr: TransformerModel;
  transport: TransportModel;
  noise: TapeNoise;
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
      { name: 'outputGain', defaultValue: 1.0,  minValue: 0.0625, maxValue: 16.0, automationRate: 'k-rate' },
    ];
  }

  private channels: ChannelDSP[] = [];
  private alive = true;
  private bypassed = false;
  private meterFrame = 0;
  private nextMeterFrame: number;

  // VU ballistics state
  private vuPower: number[] = [];
  private peakHold: number[] = [];
  private vuAttackCoeff = 0;
  private vuReleaseCoeff = 0;
  private peakReleaseCoeff = 0;

  // Per-stage metering accumulators: [input, output]
  private stageLevels: Map<StageId, { vuPower: number[]; peakHold: number[] }> = new Map();

  // Per-stage saturation accumulators (smoothed 0-1 depth, only for nonlinear stages)
  private stageSaturation: Map<StageId, number> = new Map();

  // Per-stage trim gain (linear): Map<StageId, number>
  private stageGainLin: Map<StageId, number> = new Map();

  // Store current options for reinit
  private oversampleFactor: number;
  private tapeSpeed: TapeSpeed;
  private currentPreset: MachinePreset;

  // Per-stage bypass map
  private stageBypassed: Map<StageId, boolean> = new Map();

  // Crossfade state for click-free bypass transitions
  private bypassFade = 0;                             // 0 = active, 1 = fully bypassed
  private stageFade: Map<StageId, number> = new Map(); // per-stage: 0 = bypassed, 1 = active
  private smoothedBias: number[] = [];                 // per-channel smoothed bias
  private static readonly CROSSFADE_SAMPLES = 128;     // ~2.7ms at 48kHz

  // Per-stage param overrides from graph view (take precedence over AudioParams)
  private stageParamOverrides: Map<string, number> = new Map();

  // Pre-allocated scratch buffer for single-sample oversampling (avoids GC in audio thread)
  private readonly singleSample = new Float32Array(1);

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super();

    const opts = options?.processorOptions ?? {};
    const presetName = (opts.preset as string) ?? 'studer';
    this.oversampleFactor = (opts.oversample as number) ?? 2;
    this.tapeSpeed = (opts.tapeSpeed as TapeSpeed) ?? 15;

    this.currentPreset = PRESETS[presetName] ?? PRESETS['studer'];

    // Compute VU ballistics coefficients
    this.vuAttackCoeff = Math.exp(-1 / (sampleRate * VU_ATTACK_SECONDS));
    this.vuReleaseCoeff = Math.exp(-1 / (sampleRate * VU_RELEASE_SECONDS));
    this.peakReleaseCoeff = Math.exp(-1 / (sampleRate * PEAK_RELEASE_SECONDS));

    this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);

    // Meter timing: send meter data approximately every 50 ms
    this.nextMeterFrame = Math.floor((50 / 1000) * sampleRate);

    // Message handling
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      const type = data.type as string;

      if (type === 'set-preset') {
        this.currentPreset = PRESETS[data.value as string ?? 'studer'] ?? PRESETS['studer'];
        this.stageBypassed.clear();
        this.stageFade.clear();
        this.stageParamOverrides.clear();
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
      } else if (type === 'set-speed') {
        this.tapeSpeed = (data.value as TapeSpeed) ?? 15;
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
      } else if (type === 'set-oversample') {
        this.oversampleFactor = (data.value as number) ?? 2;
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
      } else if (type === 'set-bypass') {
        this.bypassed = !!data.value;
      } else if (type === 'clear-param-overrides') {
        // CompactView changed an AudioParam — clear all overrides so AudioParams take effect
        this.stageParamOverrides.clear();
      } else if (type === 'set-stage-bypass') {
        this.stageBypassed.set(data.stageId as StageId, !!data.value);
      } else if (type === 'set-stage-variant') {
        this.handleVariantChange(data.stageId as StageId, data.value as string);
      } else if (type === 'set-stage-param') {
        this.handleStageParam(data.stageId as StageId, data.param as string, data.value as number);
      } else if (type === 'dispose') {
        this.alive = false;
      }
    };
  }

  private handleVariantChange(stageId: StageId, value: string): void {
    const fs = sampleRate;
    const preset = this.currentPreset;

    for (const dsp of this.channels) {
      if (stageId === 'recordAmp') {
        const ampType = value as 'tube' | 'transistor';
        const circuit = ampType === 'tube' ? preset.tubeCircuit : undefined;
        dsp.recordAmp = new AmplifierModel(ampType, preset.recordAmpDrive, circuit, fs * this.oversampleFactor);
      } else if (stageId === 'playbackAmp') {
        const ampType = value as 'tube' | 'transistor';
        const circuit = ampType === 'tube' ? preset.tubeCircuit : undefined;
        dsp.playbackAmp = new AmplifierModel(ampType, preset.playbackAmpDrive, circuit, fs);
      } else if (stageId === 'recordEQ') {
        const standard = value as 'NAB' | 'IEC';
        dsp.recordEQ = new TapeEQ(fs * this.oversampleFactor, standard, this.tapeSpeed, 'record');
      } else if (stageId === 'playbackEQ') {
        const standard = value as 'NAB' | 'IEC';
        dsp.playbackEQ = new TapeEQ(fs, standard, this.tapeSpeed, 'playback');
      }
    }
  }

  private handleStageParam(stageId: StageId, param: string, value: number): void {
    // Store override so process loop doesn't clobber it with AudioParam values
    this.stageParamOverrides.set(`${stageId}.${param}`, value);

    // _trim is a synthetic param — apply as dB→linear multiplier, not routed to DSP
    if (param === '_trim') {
      this.stageGainLin.set(stageId, Math.pow(10, value / 20));
      return;
    }

    for (const dsp of this.channels) {
      switch (stageId) {
        case 'inputXfmr':
          if (param === 'inputGain') dsp.inputXfmr.reconfigure({ inputGain: value });
          else if (param === 'satAmount') dsp.inputXfmr.reconfigure({ satAmount: value });
          else if (param === 'hfResonance') dsp.inputXfmr.reconfigure({ hfResonance: value });
          else if (param === 'hfQ') dsp.inputXfmr.reconfigure({ hfQ: value });
          else if (param === 'lfCutoff') dsp.inputXfmr.reconfigure({ lfCutoff: value });
          break;
        case 'recordAmp':
          if (param === 'drive') dsp.recordAmp.setDrive(value);
          else if (param === 'Vpp') dsp.recordAmp.setVpp(value);
          break;
        case 'recordEQ':
          if (param === 'color') dsp.recordEQ.setColor(value);
          break;
        case 'bias':
          if (param === 'level') {
            // Bias is applied parametrically to the hysteresis model.
            dsp.hysteresis.setBias(value);
          } else if (param === 'frequency') {
            // Legacy no-op: additive bias oscillator path was removed.
          }
          break;
        case 'hysteresis':
          if (param === 'drive') dsp.hysteresis.setDrive(value);
          else if (param === 'saturation') dsp.hysteresis.setSaturation(value);
          else if (param === 'k') dsp.hysteresis.setK(value);
          else if (param === 'c') dsp.hysteresis.setBaseC(value);
          break;
        case 'head':
          if (param === 'bumpGainDb') dsp.head.setBumpGain(value);
          break;
        case 'transport':
          if (param === 'wow') dsp.transport.setWow(value);
          else if (param === 'flutter') dsp.transport.setFlutter(value);
          else if (param === 'wowRate') dsp.transport.setWowRate(value);
          else if (param === 'flutterRate') dsp.transport.setFlutterRate(value);
          break;
        case 'playbackAmp':
          if (param === 'drive') dsp.playbackAmp.setDrive(value);
          else if (param === 'Vpp') dsp.playbackAmp.setVpp(value);
          break;
        case 'outputXfmr':
          if (param === 'inputGain') dsp.outputXfmr.reconfigure({ inputGain: value });
          else if (param === 'satAmount') dsp.outputXfmr.reconfigure({ satAmount: value });
          else if (param === 'hfResonance') dsp.outputXfmr.reconfigure({ hfResonance: value });
          else if (param === 'hfQ') dsp.outputXfmr.reconfigure({ hfQ: value });
          else if (param === 'lfCutoff') dsp.outputXfmr.reconfigure({ lfCutoff: value });
          break;
        case 'noise':
          if (param === 'hiss') dsp.noise.setLevel(value);
          break;
        // 'output' stage: outputGain is handled via override in the process loop
        // (no per-channel DSP object to call — it's a global param)
      }
    }
  }

  private initDSP(
    channels: number,
    preset: MachinePreset,
    oversampleFactor: number,
    speed: TapeSpeed,
  ): void {
    const fs = sampleRate;
    this.channels = [];

    // Initialize VU ballistics arrays
    this.vuPower = Array(channels).fill(1e-10);
    this.peakHold = Array(channels).fill(0);

    // Initialize per-stage metering accumulators ([input, output])
    for (const id of ALL_STAGE_IDS) {
      this.stageLevels.set(id, {
        vuPower: [1e-10, 1e-10],
        peakHold: [0, 0],
      });
      if (!this.stageGainLin.has(id)) {
        this.stageGainLin.set(id, 1.0);
      }
    }

    for (const id of ['inputXfmr', 'recordAmp', 'hysteresis', 'playbackAmp', 'outputXfmr'] as StageId[]) {
      this.stageSaturation.set(id, 0);
    }

    for (let ch = 0; ch < channels; ch++) {
      const inputXfmr = new TransformerModel(fs * oversampleFactor, preset.inputTransformer);
      const recordAmp = new AmplifierModel(preset.ampType, preset.recordAmpDrive, preset.tubeCircuit, fs * oversampleFactor);
      const recordEQ = new TapeEQ(fs * oversampleFactor, preset.eqStandard, speed, 'record');

      const hysteresis = new HysteresisProcessor(fs * oversampleFactor);
      hysteresis.setDrive(preset.drive);
      hysteresis.setSaturation(preset.saturation);
      hysteresis.setK(preset.tapeFormulation.k);
      hysteresis.setBaseC(preset.tapeFormulation.c);
      hysteresis.setAlpha(preset.tapeFormulation.alpha);

      const recordOversampler = new Oversampler(oversampleFactor);
      const head = new HeadModel(fs, speed, {
        gapWidth: preset.headGapWidth,
        spacing: preset.headSpacing,
        bumpGainDb: preset.bumpGainDb,
      });
      const playbackOversampler = new Oversampler(oversampleFactor);
      const playbackAmp = new AmplifierModel(preset.ampType, preset.playbackAmpDrive, preset.tubeCircuit, fs * oversampleFactor);
      const playbackEQ = new TapeEQ(fs * oversampleFactor, preset.eqStandard, speed, 'playback');
      const outputXfmr = new TransformerModel(fs * oversampleFactor, preset.outputTransformer);

      const transport = new TransportModel(fs, ch);
      transport.setWow(preset.wowDefault);
      transport.setFlutter(preset.flutterDefault);

      const noise = new TapeNoise(fs);
      noise.setLevel(preset.hissDefault);

      this.channels.push({
        inputXfmr,
        recordAmp,
        recordEQ,
        hysteresis,
        recordOversampler,
        head,
        playbackOversampler,
        playbackAmp,
        playbackEQ,
        outputXfmr,
        transport,
        noise,
      });
    }

    // Initialize crossfade state to match current bypass settings
    for (const id of ALL_STAGE_IDS) {
      this.stageFade.set(id, (this.stageBypassed.get(id) ?? false) ? 0 : 1);
    }
    this.smoothedBias = Array(channels).fill(0.5);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) {
      return this.alive;
    }

    const numChannels = Math.min(input.length, output.length, this.channels.length);
    const blockSize = input[0].length;

    // Read k-rate parameters (single value per block)
    const inputGain  = parameters['inputGain'][0];
    const biasParam  = parameters['bias'][0];
    const drive      = parameters['drive'][0];
    const saturation = parameters['saturation'][0];
    const ampDrive   = parameters['ampDrive'][0];
    const wow        = parameters['wow'][0];
    const flutter    = parameters['flutter'][0];
    const hiss       = parameters['hiss'][0];
    const outputGain = this.stageParamOverrides.get('output.outputGain') ?? parameters['outputGain'][0];

    const singleSample = this.singleSample;

    // Cache ballistics coefficients as locals for inner loop
    const attackCoeff = this.vuAttackCoeff;
    const releaseCoeff = this.vuReleaseCoeff;
    const peakRelCoeff = this.peakReleaseCoeff;

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

    const updateStageMeter = (
      sl: { vuPower: number[]; peakHold: number[] },
      slot: 0 | 1,
      sample: number,
    ): void => {
      const power = sample * sample;
      sl.vuPower[slot] += (power - sl.vuPower[slot]) * (power > sl.vuPower[slot] ? (1 - attackCoeff) : (1 - releaseCoeff));
      sl.peakHold[slot] = Math.max(Math.abs(sample), sl.peakHold[slot] * peakRelCoeff);
    };

    // Variant that accepts pre-computed average power and block peak, so the
    // oversampled stages can accumulate across the block and apply a single
    // base-rate update, keeping VU time constants independent of oversample factor.
    const updateStageMeterPwr = (
      sl: { vuPower: number[]; peakHold: number[] },
      slot: 0 | 1,
      power: number,
      peak: number,
    ): void => {
      sl.vuPower[slot] += (power - sl.vuPower[slot]) * (power > sl.vuPower[slot] ? (1 - attackCoeff) : (1 - releaseCoeff));
      sl.peakHold[slot] = Math.max(peak, sl.peakHold[slot] * peakRelCoeff);
    };

    // Per-stage crossfade state (cached as locals for inner loop)
    const fadeStep = 1 / TapeProcessor.CROSSFADE_SAMPLES;
    let fadeInputXfmr = this.stageFade.get('inputXfmr') ?? (bypassInputXfmr ? 0 : 1);
    let fadeRecordAmp = this.stageFade.get('recordAmp') ?? (bypassRecordAmp ? 0 : 1);
    let fadeRecordEQ = this.stageFade.get('recordEQ') ?? (bypassRecordEQ ? 0 : 1);
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
    const initFadeHysteresis = fadeHysteresis;
    const initFadeHead = fadeHead;
    const initFadeTransport = fadeTransport;
    const initFadeNoise = fadeNoise;
    const initFadePlaybackAmp = fadePlaybackAmp;
    const initFadePlaybackEQ = fadePlaybackEQ;
    const initFadeOutputXfmr = fadeOutputXfmr;
    const initBypassFade = bypassFade;

    // Bias smoothing: per-sample one-pole filter to prevent clicks on bias bypass toggle
    const targetBias = bypassBias ? 0 : (this.stageParamOverrides.get('bias.level') ?? biasParam);
    const biasSmoothCoeff = Math.exp(-1 / (sampleRate * 0.003)); // 3ms time constant

    const advanceFade = (current: number, bypassed: boolean): number => {
      const target = bypassed ? 0 : 1;
      if (current === target) return current;
      return Math.max(0, Math.min(1, current + (target > current ? fadeStep : -fadeStep)));
    };

    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];
      const out = output[ch];

      // Restore fades for stereo coherence (each channel gets same crossfade)
      if (ch > 0) {
        fadeInputXfmr = initFadeInputXfmr;
        fadeRecordAmp = initFadeRecordAmp;
        fadeRecordEQ = initFadeRecordEQ;
        fadeHysteresis = initFadeHysteresis;
        fadeHead = initFadeHead;
        fadeTransport = initFadeTransport;
        fadeNoise = initFadeNoise;
        fadePlaybackAmp = initFadePlaybackAmp;
        fadePlaybackEQ = initFadePlaybackEQ;
        fadeOutputXfmr = initFadeOutputXfmr;
        bypassFade = initBypassFade;
      }

      // Update DSP modules with current parameter values (always, even when bypassed,
      // to keep internal state in sync with UI for click-free un-bypass).
      // Stage param overrides (from graph view) take precedence over AudioParams.
      const ov = this.stageParamOverrides;
      // Bias is modeled parametrically: the bias knob controls the hysteresis
      // reversibility (c parameter) rather than generating an ultrasonic carrier.
      // This avoids aliasing artifacts from the bias frequency at achievable
      // sample rates and is physically equivalent to the effect of AC bias
      // on the tape magnetization process.
      dsp.hysteresis.setDrive(ov.get('hysteresis.drive') ?? drive);
      dsp.hysteresis.setSaturation(ov.get('hysteresis.saturation') ?? saturation);
      dsp.recordAmp.setDrive(ov.get('recordAmp.drive') ?? ampDrive);
      dsp.playbackAmp.setDrive(ov.get('playbackAmp.drive') ?? ampDrive);
      dsp.transport.setWow(ov.get('transport.wow') ?? wow);
      dsp.transport.setFlutter(ov.get('transport.flutter') ?? flutter);
      dsp.noise.setLevel(ov.get('noise.hiss') ?? hiss);

      for (let i = 0; i < blockSize; i++) {
        const dry = inp[i];
        let x = dry * inputGain;

        updateStageMeter(slInputXfmr, 0, x);

        // Per-sample bias smoothing (prevents click on bias bypass toggle)
        this.smoothedBias[ch] += (targetBias - this.smoothedBias[ch]) * (1 - biasSmoothCoeff);
        dsp.hysteresis.setBias(this.smoothedBias[ch]);

        // --- RECORD CHAIN (Always oversampled to keep FIR/ODE state current) ---
        singleSample[0] = x;
        const recUpsampled = dsp.recordOversampler.upsample(singleSample);
        const recOsLen = recUpsampled.length;

        let p0 = 0, k0 = 0, p1 = 0, k1 = 0, p2 = 0, k2 = 0, p3 = 0, k3 = 0;
        let maxSatInputXfmr = 0, maxSatRecordAmp = 0, maxSatHysteresis = 0;

        for (let j = 0; j < recOsLen; j++) {
          let v = recUpsampled[j];

          // inputXfmr: always process, blend with dry
          const dryXfmr = v;
          v = dsp.inputXfmr.process(v) * trimInputXfmr;
          maxSatInputXfmr = Math.max(maxSatInputXfmr, dsp.inputXfmr.getSaturationDepth());
          v = dryXfmr + (v - dryXfmr) * fadeInputXfmr;
          p0 += v * v; k0 = Math.max(k0, Math.abs(v));

          // recordAmp: always process, blend with dry
          const dryRamp = v;
          v = dsp.recordAmp.process(v) * trimRecordAmp;
          maxSatRecordAmp = Math.max(maxSatRecordAmp, dsp.recordAmp.getSaturationDepth());
          v = dryRamp + (v - dryRamp) * fadeRecordAmp;
          p1 += v * v; k1 = Math.max(k1, Math.abs(v));

          // recordEQ: always process, blend with dry
          const dryReq = v;
          v = dsp.recordEQ.process(v) * trimRecordEQ;
          v = dryReq + (v - dryReq) * fadeRecordEQ;
          p2 += v * v; k2 = Math.max(k2, Math.abs(v));

          // hysteresis: always process, blend with dry
          const dryHyst = v;
          v = dsp.hysteresis.process(v) * trimHysteresis;
          maxSatHysteresis = Math.max(maxSatHysteresis, dsp.hysteresis.getSaturationDepth());
          v = dryHyst + (v - dryHyst) * fadeHysteresis;
          p3 += v * v; k3 = Math.max(k3, Math.abs(v));

          recUpsampled[j] = v;
        }

        const recOoN = 1 / recOsLen;
        updateStageMeterPwr(slInputXfmr,  1, p0 * recOoN, k0);
        updateStageMeterPwr(slRecordAmp,  0, p0 * recOoN, k0);
        updateStageMeterPwr(slRecordAmp,  1, p1 * recOoN, k1);
        updateStageMeterPwr(slRecordEQ,   0, p1 * recOoN, k1);
        updateStageMeterPwr(slRecordEQ,   1, p2 * recOoN, k2);
        updateStageMeterPwr(slHysteresis, 0, p2 * recOoN, k2);
        updateStageMeterPwr(slHysteresis, 1, p3 * recOoN, k3);

        x = dsp.recordOversampler.downsample(recUpsampled)[0];

        // Update saturation accumulators (scaled by fade so meters show 0 when bypassed)
        maxSatInputXfmr *= fadeInputXfmr;
        const prevSatIxfmr = this.stageSaturation.get('inputXfmr')!;
        this.stageSaturation.set('inputXfmr', prevSatIxfmr + (maxSatInputXfmr - prevSatIxfmr) * (maxSatInputXfmr > prevSatIxfmr ? (1 - attackCoeff) : (1 - releaseCoeff)));

        maxSatRecordAmp *= fadeRecordAmp;
        const prevSatRamp = this.stageSaturation.get('recordAmp')!;
        this.stageSaturation.set('recordAmp', prevSatRamp + (maxSatRecordAmp - prevSatRamp) * (maxSatRecordAmp > prevSatRamp ? (1 - attackCoeff) : (1 - releaseCoeff)));

        maxSatHysteresis *= fadeHysteresis;
        const prevSatHyst = this.stageSaturation.get('hysteresis')!;
        this.stageSaturation.set('hysteresis', prevSatHyst + (maxSatHysteresis - prevSatHyst) * (maxSatHysteresis > prevSatHyst ? (1 - attackCoeff) : (1 - releaseCoeff)));

        // Bias metering
        updateStageMeter(slBias, 0, x);
        updateStageMeter(slBias, 1, x);

        // --- TAPE/HEAD INTERFACE (Base rate, always process + blend) ---
        updateStageMeter(slHead, 0, x);
        const dryHead = x;
        x = dsp.head.process(x) * trimHead;
        x = dryHead + (x - dryHead) * fadeHead;
        updateStageMeter(slHead, 1, x);

        updateStageMeter(slTransport, 0, x);
        const dryTransport = x;
        x = dsp.transport.process(x) * trimTransport;
        x = dryTransport + (x - dryTransport) * fadeTransport;
        updateStageMeter(slTransport, 1, x);

        updateStageMeter(slNoise, 0, x);
        const dryNoise = x;
        x = (x + dsp.noise.process(Math.abs(x))) * trimNoise;
        x = dryNoise + (x - dryNoise) * fadeNoise;
        updateStageMeter(slNoise, 1, x);

        // --- PLAYBACK CHAIN (Always oversampled to keep FIR/ODE state current) ---
        updateStageMeter(slPlaybackAmp, 0, x);
        singleSample[0] = x;
        const pbUpsampled = dsp.playbackOversampler.upsample(singleSample);
        const pbOsLen = pbUpsampled.length;

        let pb0 = 0, pk0 = 0, pb1 = 0, pk1 = 0, pb2 = 0, pk2 = 0;
        let maxSatPlaybackAmp = 0, maxSatOutputXfmr = 0;

        for (let j = 0; j < pbOsLen; j++) {
          let v = pbUpsampled[j];

          // playbackAmp: always process, blend with dry
          const dryPamp = v;
          v = dsp.playbackAmp.process(v) * trimPlaybackAmp;
          maxSatPlaybackAmp = Math.max(maxSatPlaybackAmp, dsp.playbackAmp.getSaturationDepth());
          v = dryPamp + (v - dryPamp) * fadePlaybackAmp;
          pb0 += v * v; pk0 = Math.max(pk0, Math.abs(v));

          // playbackEQ: always process, blend with dry
          const dryPeq = v;
          v = dsp.playbackEQ.process(v) * trimPlaybackEQ;
          v = dryPeq + (v - dryPeq) * fadePlaybackEQ;
          pb1 += v * v; pk1 = Math.max(pk1, Math.abs(v));

          // outputXfmr: always process, blend with dry
          const dryOxfmr = v;
          v = dsp.outputXfmr.process(v) * trimOutputXfmr;
          maxSatOutputXfmr = Math.max(maxSatOutputXfmr, dsp.outputXfmr.getSaturationDepth());
          v = dryOxfmr + (v - dryOxfmr) * fadeOutputXfmr;
          pb2 += v * v; pk2 = Math.max(pk2, Math.abs(v));

          pbUpsampled[j] = v;
        }

        const pbOoN = 1 / pbOsLen;
        updateStageMeterPwr(slPlaybackAmp,  1, pb0 * pbOoN, pk0);
        updateStageMeterPwr(slPlaybackEQ,   0, pb0 * pbOoN, pk0);
        updateStageMeterPwr(slPlaybackEQ,   1, pb1 * pbOoN, pk1);
        updateStageMeterPwr(slOutputXfmr,   0, pb1 * pbOoN, pk1);
        updateStageMeterPwr(slOutputXfmr,   1, pb2 * pbOoN, pk2);

        x = dsp.playbackOversampler.downsample(pbUpsampled)[0];

        // Update saturation accumulators (scaled by fade)
        maxSatPlaybackAmp *= fadePlaybackAmp;
        const prevSatPamp = this.stageSaturation.get('playbackAmp')!;
        this.stageSaturation.set('playbackAmp', prevSatPamp + (maxSatPlaybackAmp - prevSatPamp) * (maxSatPlaybackAmp > prevSatPamp ? (1 - attackCoeff) : (1 - releaseCoeff)));

        maxSatOutputXfmr *= fadeOutputXfmr;
        const prevSatOxfmr = this.stageSaturation.get('outputXfmr')!;
        this.stageSaturation.set('outputXfmr', prevSatOxfmr + (maxSatOutputXfmr - prevSatOxfmr) * (maxSatOutputXfmr > prevSatOxfmr ? (1 - attackCoeff) : (1 - releaseCoeff)));

        // Safety net: avoid NaN/Infinity propagating to the output channel.
        if (!Number.isFinite(x)) x = 0;

        // Clamp to [-2, 2]
        x = Math.max(-2, Math.min(2, x));

        // Global bypass crossfade
        updateStageMeter(slOutput, 0, x);
        const globalTarget = this.bypassed ? 1 : 0;
        if (bypassFade !== globalTarget) {
          bypassFade += globalTarget > bypassFade ? fadeStep : -fadeStep;
          bypassFade = Math.max(0, Math.min(1, bypassFade));
        }
        out[i] = dry * bypassFade + (x * outputGain) * (1 - bypassFade);
        updateStageMeter(slOutput, 1, out[i]);

        // Advance per-stage fades toward their targets
        fadeInputXfmr = advanceFade(fadeInputXfmr, bypassInputXfmr);
        fadeRecordAmp = advanceFade(fadeRecordAmp, bypassRecordAmp);
        fadeRecordEQ = advanceFade(fadeRecordEQ, bypassRecordEQ);
        fadeHysteresis = advanceFade(fadeHysteresis, bypassHysteresis);
        fadeHead = advanceFade(fadeHead, bypassHead);
        fadeTransport = advanceFade(fadeTransport, bypassTransport);
        fadeNoise = advanceFade(fadeNoise, bypassNoise);
        fadePlaybackAmp = advanceFade(fadePlaybackAmp, bypassPlaybackAmp);
        fadePlaybackEQ = advanceFade(fadePlaybackEQ, bypassPlaybackEQ);
        fadeOutputXfmr = advanceFade(fadeOutputXfmr, bypassOutputXfmr);

        // VU ballistics metering (per-sample)
        const power = out[i] * out[i];
        const vuCoeff = power > this.vuPower[ch] ? attackCoeff : releaseCoeff;
        this.vuPower[ch] = vuCoeff * this.vuPower[ch] + (1 - vuCoeff) * power;
        this.peakHold[ch] = Math.max(Math.abs(out[i]), this.peakHold[ch] * peakRelCoeff);
      }
    }

    // Store crossfade state back
    this.stageFade.set('inputXfmr', fadeInputXfmr);
    this.stageFade.set('recordAmp', fadeRecordAmp);
    this.stageFade.set('recordEQ', fadeRecordEQ);
    this.stageFade.set('hysteresis', fadeHysteresis);
    this.stageFade.set('head', fadeHead);
    this.stageFade.set('transport', fadeTransport);
    this.stageFade.set('noise', fadeNoise);
    this.stageFade.set('playbackAmp', fadePlaybackAmp);
    this.stageFade.set('playbackEQ', fadePlaybackEQ);
    this.stageFade.set('outputXfmr', fadeOutputXfmr);
    this.bypassFade = bypassFade;

    // Send meter data approximately every 50 ms
    this.meterFrame += blockSize;
    if (this.meterFrame >= this.nextMeterFrame) {
      this.meterFrame = 0;

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

      // Build per-stage meter data
      const levels: Record<string, { vuDb: number[]; peakDb: number[]; saturation?: number }> = {};
      for (const id of ALL_STAGE_IDS) {
        const sl = this.stageLevels.get(id)!;
        const sVuDb: number[] = [];
        const sPeakDb: number[] = [];
        for (let slot = 0; slot < 2; slot++) {
          const vu = 10 * Math.log10(Math.max(sl.vuPower[slot], 1e-10));
          sVuDb.push(Math.max(-60, Math.min(9, vu)));
          const pk = sl.peakHold[slot] > 0 ? 20 * Math.log10(sl.peakHold[slot]) : -60;
          sPeakDb.push(Math.max(-60, Math.min(9, pk)));
        }
        levels[id] = { vuDb: sVuDb, peakDb: sPeakDb };
        const sat = this.stageSaturation.get(id);
        if (sat !== undefined) {
          levels[id].saturation = sat;
        }
      }

      this.port.postMessage({
        type: 'stage-meters',
        levels,
      });
    }

    return this.alive;
  }
}

registerProcessor('tape-processor', TapeProcessor);
