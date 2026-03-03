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

    // Skip oversampling only when all oversampled stages are bypassed
    // (bias is now parametric, not in the oversampled chain)
    const skipOversampling = bypassRecordAmp && bypassRecordEQ && bypassHysteresis;

    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];
      const out = output[ch];

      // Update DSP modules with current parameter values.
      // Stage param overrides (from graph view) take precedence over AudioParams.
      const ov = this.stageParamOverrides;
      // Bias is modeled parametrically: the bias knob controls the hysteresis
      // reversibility (c parameter) rather than generating an ultrasonic carrier.
      // This avoids aliasing artifacts from the bias frequency at achievable
      // sample rates and is physically equivalent to the effect of AC bias
      // on the tape magnetization process.
      if (!bypassHysteresis) {
        dsp.hysteresis.setDrive(ov.get('hysteresis.drive') ?? drive);
        dsp.hysteresis.setSaturation(ov.get('hysteresis.saturation') ?? saturation);
        // Bypass bias = no AC bias (biasAmplitude=0, c stays at baseC — underbias state).
        dsp.hysteresis.setBias(bypassBias ? 0 : (ov.get('bias.level') ?? biasParam));
      }
      if (!bypassRecordAmp) dsp.recordAmp.setDrive(ov.get('recordAmp.drive') ?? ampDrive);
      if (!bypassPlaybackAmp) dsp.playbackAmp.setDrive(ov.get('playbackAmp.drive') ?? ampDrive);
      if (!bypassTransport) {
        dsp.transport.setWow(ov.get('transport.wow') ?? wow);
        dsp.transport.setFlutter(ov.get('transport.flutter') ?? flutter);
      }
      if (!bypassNoise) dsp.noise.setLevel(ov.get('noise.hiss') ?? hiss);

      for (let i = 0; i < blockSize; i++) {
        const dry = inp[i];
        let x = dry * inputGain;

        updateStageMeter(slInputXfmr, 0, x);

        const skipRecordOversampling = bypassInputXfmr && bypassRecordAmp && bypassRecordEQ && bypassHysteresis;
        
        // --- RECORD CHAIN (Oversampled) ---
        if (!skipRecordOversampling) {
          singleSample[0] = x;
          const upsampled = dsp.recordOversampler.upsample(singleSample);
          const osLen = upsampled.length;

          let p0 = 0, k0 = 0, p1 = 0, k1 = 0, p2 = 0, k2 = 0, p3 = 0, k3 = 0, p4 = 0, k4 = 0;
          let maxSatInputXfmr = 0, maxSatRecordAmp = 0, maxSatHysteresis = 0;

          for (let j = 0; j < osLen; j++) {
            let v = upsampled[j];
            
            if (!bypassInputXfmr) {
              v = dsp.inputXfmr.process(v);
              maxSatInputXfmr = Math.max(maxSatInputXfmr, dsp.inputXfmr.getSaturationDepth());
              v *= trimInputXfmr;
            }
            p0 += v * v; k0 = Math.max(k0, Math.abs(v));

            if (!bypassRecordAmp) {
              v = dsp.recordAmp.process(v);
              maxSatRecordAmp = Math.max(maxSatRecordAmp, dsp.recordAmp.getSaturationDepth());
              v *= trimRecordAmp;
            }
            p1 += v * v; k1 = Math.max(k1, Math.abs(v));

            if (!bypassRecordEQ) {
              v = dsp.recordEQ.process(v);
              v *= trimRecordEQ;
            }
            p2 += v * v; k2 = Math.max(k2, Math.abs(v));

            if (!bypassHysteresis) {
              v = dsp.hysteresis.process(v);
              maxSatHysteresis = Math.max(maxSatHysteresis, dsp.hysteresis.getSaturationDepth());
              v *= trimHysteresis;
            }
            p3 += v * v; k3 = Math.max(k3, Math.abs(v));

            upsampled[j] = v;
          }

          const ooN = 1 / osLen;
          updateStageMeterPwr(slInputXfmr,  1, p0 * ooN, k0);
          updateStageMeterPwr(slRecordAmp,  0, p0 * ooN, k0);
          updateStageMeterPwr(slRecordAmp,  1, p1 * ooN, k1);
          updateStageMeterPwr(slRecordEQ,   0, p1 * ooN, k1);
          updateStageMeterPwr(slRecordEQ,   1, p2 * ooN, k2);
          updateStageMeterPwr(slHysteresis, 0, p2 * ooN, k2);
          updateStageMeterPwr(slHysteresis, 1, p3 * ooN, k3);

          x = dsp.recordOversampler.downsample(upsampled)[0];

          if (!bypassInputXfmr) {
            const prev = this.stageSaturation.get('inputXfmr')!;
            this.stageSaturation.set('inputXfmr', prev + (maxSatInputXfmr - prev) * (maxSatInputXfmr > prev ? (1 - attackCoeff) : (1 - releaseCoeff)));
          } else {
            this.stageSaturation.set('inputXfmr', this.stageSaturation.get('inputXfmr')! * releaseCoeff);
          }
          if (!bypassRecordAmp) {
            const prev = this.stageSaturation.get('recordAmp')!;
            this.stageSaturation.set('recordAmp', prev + (maxSatRecordAmp - prev) * (maxSatRecordAmp > prev ? (1 - attackCoeff) : (1 - releaseCoeff)));
          } else {
            this.stageSaturation.set('recordAmp', this.stageSaturation.get('recordAmp')! * releaseCoeff);
          }
          if (!bypassHysteresis) {
            const prev = this.stageSaturation.get('hysteresis')!;
            this.stageSaturation.set('hysteresis', prev + (maxSatHysteresis - prev) * (maxSatHysteresis > prev ? (1 - attackCoeff) : (1 - releaseCoeff)));
          } else {
            this.stageSaturation.set('hysteresis', this.stageSaturation.get('hysteresis')! * releaseCoeff);
          }
        } else {
          // Bypassed record chain
          const v0pwr = x * x; const v0abs = Math.abs(x);
          updateStageMeterPwr(slInputXfmr, 1, v0pwr, v0abs);
          updateStageMeterPwr(slRecordAmp, 0, v0pwr, v0abs);
          
          const v1pwr = x * x; const v1abs = Math.abs(x);
          updateStageMeterPwr(slRecordAmp,  1, v1pwr, v1abs);
          updateStageMeterPwr(slRecordEQ,   0, v1pwr, v1abs);
          
          const v2pwr = x * x; const v2abs = Math.abs(x);
          updateStageMeterPwr(slRecordEQ,   1, v2pwr, v2abs);
          updateStageMeterPwr(slHysteresis, 0, v2pwr, v2abs);
          
          const v3pwr = x * x; const v3abs = Math.abs(x);
          updateStageMeterPwr(slHysteresis, 1, v3pwr, v3abs);
          
          this.stageSaturation.set('inputXfmr', this.stageSaturation.get('inputXfmr')! * releaseCoeff);
          this.stageSaturation.set('recordAmp', this.stageSaturation.get('recordAmp')! * releaseCoeff);
          this.stageSaturation.set('hysteresis', this.stageSaturation.get('hysteresis')! * releaseCoeff);
        }

        // Bias metering
        updateStageMeter(slBias, 0, x);
        updateStageMeter(slBias, 1, x);

        // --- TAPE/HEAD INTERFACE (Base rate) ---
        updateStageMeter(slHead, 0, x);
        if (!bypassHead) {
          x = dsp.head.process(x);
          x *= trimHead;
        }
        updateStageMeter(slHead, 1, x);

        updateStageMeter(slTransport, 0, x);
        if (!bypassTransport) {
          x = dsp.transport.process(x);
          x *= trimTransport;
        }
        updateStageMeter(slTransport, 1, x);

        updateStageMeter(slNoise, 0, x);
        if (!bypassNoise) {
          x += dsp.noise.process(Math.abs(x));
          x *= trimNoise;
        }
        updateStageMeter(slNoise, 1, x);

        // --- PLAYBACK CHAIN (Oversampled) ---
        const skipPlaybackOversampling = bypassPlaybackAmp && bypassPlaybackEQ && bypassOutputXfmr;
        
        if (!skipPlaybackOversampling) {
          singleSample[0] = x;
          const upsampled = dsp.playbackOversampler.upsample(singleSample);
          const osLen = upsampled.length;

          let p0 = 0, k0 = 0, p1 = 0, k1 = 0, p2 = 0, k2 = 0;
          let maxSatPlaybackAmp = 0, maxSatOutputXfmr = 0;
          
          // Before playback chain
          updateStageMeter(slPlaybackAmp, 0, x);

          for (let j = 0; j < osLen; j++) {
            let v = upsampled[j];
            
            if (!bypassPlaybackAmp) {
              v = dsp.playbackAmp.process(v);
              maxSatPlaybackAmp = Math.max(maxSatPlaybackAmp, dsp.playbackAmp.getSaturationDepth());
              v *= trimPlaybackAmp;
            }
            p0 += v * v; k0 = Math.max(k0, Math.abs(v));

            if (!bypassPlaybackEQ) {
              v = dsp.playbackEQ.process(v);
              v *= trimPlaybackEQ;
            }
            p1 += v * v; k1 = Math.max(k1, Math.abs(v));

            if (!bypassOutputXfmr) {
              v = dsp.outputXfmr.process(v);
              maxSatOutputXfmr = Math.max(maxSatOutputXfmr, dsp.outputXfmr.getSaturationDepth());
              v *= trimOutputXfmr;
            }
            p2 += v * v; k2 = Math.max(k2, Math.abs(v));

            upsampled[j] = v;
          }

          const ooN = 1 / osLen;
          updateStageMeterPwr(slPlaybackAmp,  1, p0 * ooN, k0);
          updateStageMeterPwr(slPlaybackEQ,   0, p0 * ooN, k0);
          updateStageMeterPwr(slPlaybackEQ,   1, p1 * ooN, k1);
          updateStageMeterPwr(slOutputXfmr,   0, p1 * ooN, k1);
          updateStageMeterPwr(slOutputXfmr,   1, p2 * ooN, k2);

          x = dsp.playbackOversampler.downsample(upsampled)[0];

          if (!bypassPlaybackAmp) {
            const prev = this.stageSaturation.get('playbackAmp')!;
            this.stageSaturation.set('playbackAmp', prev + (maxSatPlaybackAmp - prev) * (maxSatPlaybackAmp > prev ? (1 - attackCoeff) : (1 - releaseCoeff)));
          } else {
            this.stageSaturation.set('playbackAmp', this.stageSaturation.get('playbackAmp')! * releaseCoeff);
          }
          if (!bypassOutputXfmr) {
            const prev = this.stageSaturation.get('outputXfmr')!;
            this.stageSaturation.set('outputXfmr', prev + (maxSatOutputXfmr - prev) * (maxSatOutputXfmr > prev ? (1 - attackCoeff) : (1 - releaseCoeff)));
          } else {
            this.stageSaturation.set('outputXfmr', this.stageSaturation.get('outputXfmr')! * releaseCoeff);
          }
        } else {
          // Bypassed playback chain
          updateStageMeter(slPlaybackAmp, 0, x);
          
          const v0pwr = x * x; const v0abs = Math.abs(x);
          updateStageMeterPwr(slPlaybackAmp, 1, v0pwr, v0abs);
          updateStageMeterPwr(slPlaybackEQ, 0, v0pwr, v0abs);
          
          const v1pwr = x * x; const v1abs = Math.abs(x);
          updateStageMeterPwr(slPlaybackEQ, 1, v1pwr, v1abs);
          updateStageMeterPwr(slOutputXfmr, 0, v1pwr, v1abs);
          
          const v2pwr = x * x; const v2abs = Math.abs(x);
          updateStageMeterPwr(slOutputXfmr, 1, v2pwr, v2abs);
          
          this.stageSaturation.set('playbackAmp', this.stageSaturation.get('playbackAmp')! * releaseCoeff);
          this.stageSaturation.set('outputXfmr', this.stageSaturation.get('outputXfmr')! * releaseCoeff);
        }

        // Safety net: avoid NaN/Infinity propagating to the output channel.
        if (!Number.isFinite(x)) x = 0;

        // Clamp to [-2, 2]
        x = Math.max(-2, Math.min(2, x));

        // Bypass or processed output
        updateStageMeter(slOutput, 0, x);
        out[i] = this.bypassed ? dry : x * outputGain;
        updateStageMeter(slOutput, 1, out[i]);

        // VU ballistics metering (per-sample)
        const power = out[i] * out[i];
        const vuCoeff = power > this.vuPower[ch] ? attackCoeff : releaseCoeff;
        this.vuPower[ch] = vuCoeff * this.vuPower[ch] + (1 - vuCoeff) * power;
        this.peakHold[ch] = Math.max(Math.abs(out[i]), this.peakHold[ch] * peakRelCoeff);
      }
    }

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
