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
import { BiasOscillator } from '../dsp/bias';
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

// ---------------------------------------------------------------------------
// Per-channel DSP state
// ---------------------------------------------------------------------------

interface ChannelDSP {
  inputXfmr: TransformerModel;
  recordAmp: AmplifierModel;
  bias: BiasOscillator;
  recordEQ: TapeEQ;
  hysteresis: HysteresisProcessor;
  oversampler: Oversampler;
  head: HeadModel;
  playbackAmp: AmplifierModel;
  playbackEQ: TapeEQ;
  outputXfmr: TransformerModel;
  transport: TransportModel;
  noise: TapeNoise;
}

// ---------------------------------------------------------------------------
// Drive compensation constants
// ---------------------------------------------------------------------------

const DRIVE_COMP_NEGATIVE_SLOPE = 0.9;
const DRIVE_COMP_POSITIVE_SLOPE = 0.38;
const DRIVE_COMP_SMOOTHING = 0.002;

function computeDriveCompDb(driveNorm: number): number {
  // Convert 0-1 drive knob to approximate dB effect on output level.
  // Drive 0.5 = unity (0 dB); range roughly -12 to +12 dB.
  const driveDb = (driveNorm - 0.5) * 24;
  if (driveDb < 0) {
    return -DRIVE_COMP_NEGATIVE_SLOPE * driveDb;
  }
  return -DRIVE_COMP_POSITIVE_SLOPE * driveDb;
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
      { name: 'outputGain', defaultValue: 1.0,  minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
    ];
  }

  private channels: ChannelDSP[] = [];
  private alive = true;
  private bypassed = false;
  private autoGain = false;
  private autoGainCompLin = 1.0;
  private autoGainCompTarget = 1.0;
  private meterFrame = 0;
  private nextMeterFrame: number;

  // VU ballistics state
  private vuPower: number[] = [];
  private peakHold: number[] = [];
  private vuAttackCoeff = 0;
  private vuReleaseCoeff = 0;
  private peakReleaseCoeff = 0;

  // Store current options for reinit
  private oversampleFactor: number;
  private tapeSpeed: TapeSpeed;
  private currentPreset: MachinePreset;

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
      const data = event.data as { type: string; value?: string };
      if (data.type === 'set-preset') {
        this.currentPreset = PRESETS[data.value ?? 'studer'] ?? PRESETS['studer'];
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
      } else if (data.type === 'set-speed') {
        this.tapeSpeed = (data.value as unknown as TapeSpeed) ?? 15;
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
      } else if (data.type === 'set-oversample') {
        this.oversampleFactor = (data.value as unknown as number) ?? 2;
        this.initDSP(2, this.currentPreset, this.oversampleFactor, this.tapeSpeed);
      } else if (data.type === 'set-bypass') {
        this.bypassed = !!data.value;
      } else if (data.type === 'set-autogain') {
        this.autoGain = !!data.value;
        if (!this.autoGain) {
          this.autoGainCompLin = 1.0;
          this.autoGainCompTarget = 1.0;
        }
      } else if (data.type === 'dispose') {
        this.alive = false;
      }
    };
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

    for (let ch = 0; ch < channels; ch++) {
      const inputXfmr = new TransformerModel(fs, preset.inputTransformer);
      const recordAmp = new AmplifierModel(preset.ampType, preset.recordAmpDrive, preset.tubeCircuit, fs * oversampleFactor);

      const bias = new BiasOscillator(fs * oversampleFactor);
      bias.setLevel(preset.biasDefault);

      const recordEQ = new TapeEQ(fs, preset.eqStandard, speed, 'record');

      const hysteresis = new HysteresisProcessor(fs * oversampleFactor);
      hysteresis.setDrive(preset.drive);
      hysteresis.setSaturation(preset.saturation);

      const oversampler = new Oversampler(oversampleFactor);
      const head = new HeadModel(fs, speed);
      const playbackAmp = new AmplifierModel(preset.ampType, preset.playbackAmpDrive, preset.tubeCircuit, fs);
      const playbackEQ = new TapeEQ(fs, preset.eqStandard, speed, 'playback');
      const outputXfmr = new TransformerModel(fs, preset.outputTransformer);

      const transport = new TransportModel(fs, ch);
      transport.setWow(preset.wowDefault);
      transport.setFlutter(preset.flutterDefault);

      const noise = new TapeNoise(fs);
      noise.setLevel(preset.hissDefault);

      this.channels.push({
        inputXfmr,
        recordAmp,
        bias,
        recordEQ,
        hysteresis,
        oversampler,
        head,
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
    const outputGain = parameters['outputGain'][0];

    // Scratch buffer for single-sample oversampling
    const singleSample = new Float32Array(1);

    // Cache ballistics coefficients as locals for inner loop
    const attackCoeff = this.vuAttackCoeff;
    const releaseCoeff = this.vuReleaseCoeff;
    const peakRelCoeff = this.peakReleaseCoeff;

    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];
      const out = output[ch];

      // Update DSP modules with current parameter values
      dsp.bias.setLevel(biasParam);
      dsp.hysteresis.setDrive(drive);
      dsp.hysteresis.setSaturation(saturation);
      dsp.recordAmp.setDrive(ampDrive);
      dsp.playbackAmp.setDrive(ampDrive * 0.8);
      dsp.transport.setWow(wow);
      dsp.transport.setFlutter(flutter);
      dsp.noise.setLevel(hiss);

      // Compute deterministic drive compensation target once per block
      if (this.autoGain) {
        const compDb = computeDriveCompDb(drive) + computeDriveCompDb(saturation) * 0.5;
        this.autoGainCompTarget = Math.max(0.25, Math.min(8, Math.pow(10, compDb / 20)));
      }

      for (let i = 0; i < blockSize; i++) {
        const dry = inp[i];
        let x = dry * inputGain;

        // Input transformer
        x = dsp.inputXfmr.process(x);

        // Record EQ
        x = dsp.recordEQ.process(x);

        // Oversample for record amp + bias + hysteresis (anti-aliases harmonics
        // from both the tube nonlinearity and the tape hysteresis model)
        singleSample[0] = x;
        const upsampled = dsp.oversampler.upsample(singleSample);
        for (let j = 0; j < upsampled.length; j++) {
          upsampled[j] = dsp.recordAmp.process(upsampled[j]);
          upsampled[j] = dsp.bias.process(upsampled[j]);
          upsampled[j] = dsp.hysteresis.process(upsampled[j]);
        }
        const downsampled = dsp.oversampler.downsample(upsampled);
        x = downsampled[0];

        // Head model
        x = dsp.head.process(x);

        // Transport (wow & flutter)
        x = dsp.transport.process(x);

        // Playback amplifier
        x = dsp.playbackAmp.process(x);

        // Playback EQ
        x = dsp.playbackEQ.process(x);

        // Output transformer
        x = dsp.outputXfmr.process(x);

        // Add noise
        x += dsp.noise.process();

        // Clamp to [-2, 2]
        x = Math.max(-2, Math.min(2, x));

        // Apply per-sample smoothed drive compensation
        if (this.autoGain && !this.bypassed) {
          this.autoGainCompLin += (this.autoGainCompTarget - this.autoGainCompLin) * DRIVE_COMP_SMOOTHING;
          x *= this.autoGainCompLin;
        }

        // Bypass or processed output
        out[i] = this.bypassed ? dry : x * outputGain;

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
    }

    return this.alive;
  }
}

registerProcessor('tape-processor', TapeProcessor);
