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
// TapeProcessor
// ---------------------------------------------------------------------------

class TapeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): ParamDescriptor[] {
    return [
      { name: 'inputGain',  defaultValue: 1.0,  minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'bias',       defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'drive',      defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'saturation', defaultValue: 0.5,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'wow',        defaultValue: 0.15, minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'flutter',    defaultValue: 0.1,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'hiss',       defaultValue: 0.05, minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
      { name: 'outputGain', defaultValue: 1.0,  minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'mix',        defaultValue: 1.0,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
    ];
  }

  private channels: ChannelDSP[] = [];
  private alive = true;
  private meterFrame = 0;
  private nextMeterFrame: number;

  // Store constructor options for reinit
  private readonly oversampleFactor: number;
  private readonly tapeSpeed: TapeSpeed;

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super();

    const opts = options?.processorOptions ?? {};
    const presetName = (opts.preset as string) ?? 'studer';
    this.oversampleFactor = (opts.oversample as number) ?? 2;
    this.tapeSpeed = (opts.tapeSpeed as TapeSpeed) ?? 15;

    const preset = PRESETS[presetName] ?? PRESETS['studer'];

    this.initDSP(2, preset, this.oversampleFactor, this.tapeSpeed);

    // Meter timing: send meter data approximately every 50 ms
    this.nextMeterFrame = Math.floor((50 / 1000) * sampleRate);

    // Message handling
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; value?: string };
      if (data.type === 'set-preset') {
        const newPreset = PRESETS[data.value ?? 'studer'] ?? PRESETS['studer'];
        this.initDSP(2, newPreset, this.oversampleFactor, this.tapeSpeed);
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

    for (let ch = 0; ch < channels; ch++) {
      const inputXfmr = new TransformerModel(fs, preset.inputTransformer);
      const recordAmp = new AmplifierModel(preset.ampType, 1.0);

      const bias = new BiasOscillator(fs * oversampleFactor);
      bias.setLevel(preset.biasDefault);

      const recordEQ = new TapeEQ(fs, preset.eqStandard, speed, 'record');

      const hysteresis = new HysteresisProcessor(fs * oversampleFactor);
      hysteresis.setDrive(preset.drive);
      hysteresis.setSaturation(preset.saturation);

      const oversampler = new Oversampler(oversampleFactor);
      const head = new HeadModel(fs, speed);
      const playbackAmp = new AmplifierModel(preset.ampType, 0.8);
      const playbackEQ = new TapeEQ(fs, preset.eqStandard, speed, 'playback');
      const outputXfmr = new TransformerModel(fs, preset.outputTransformer);

      const transport = new TransportModel(fs);
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
    const wow        = parameters['wow'][0];
    const flutter    = parameters['flutter'][0];
    const hiss       = parameters['hiss'][0];
    const outputGain = parameters['outputGain'][0];
    const mix        = parameters['mix'][0];

    // Metering accumulators
    const rms = new Float32Array(numChannels);
    const peak = new Float32Array(numChannels);

    // Scratch buffer for single-sample oversampling
    const singleSample = new Float32Array(1);

    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];
      const out = output[ch];

      // Update DSP modules with current parameter values
      dsp.bias.setLevel(biasParam);
      dsp.hysteresis.setDrive(drive);
      dsp.hysteresis.setSaturation(saturation);
      dsp.transport.setWow(wow);
      dsp.transport.setFlutter(flutter);
      dsp.noise.setLevel(hiss);

      let sumSq = 0;
      let peakVal = 0;

      for (let i = 0; i < blockSize; i++) {
        const dry = inp[i];
        let x = dry * inputGain;

        // Input transformer
        x = dsp.inputXfmr.process(x);

        // Record amplifier
        x = dsp.recordAmp.process(x);

        // Record EQ
        x = dsp.recordEQ.process(x);

        // Oversample for hysteresis: upsample, apply bias + hysteresis, downsample
        singleSample[0] = x;
        const upsampled = dsp.oversampler.upsample(singleSample);
        for (let j = 0; j < upsampled.length; j++) {
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

        // Dry/wet mix with output gain
        out[i] = (dry * (1 - mix) + x * mix) * outputGain;

        // Metering
        const absOut = Math.abs(out[i]);
        sumSq += out[i] * out[i];
        if (absOut > peakVal) {
          peakVal = absOut;
        }
      }

      rms[ch] = Math.sqrt(sumSq / blockSize);
      peak[ch] = peakVal;
    }

    // Send meter data approximately every 50 ms
    this.meterFrame += blockSize;
    if (this.meterFrame >= this.nextMeterFrame) {
      this.meterFrame = 0;
      this.port.postMessage({
        type: 'meters',
        rms: Array.from(rms),
        peak: Array.from(peak),
      });
    }

    return this.alive;
  }
}

registerProcessor('tape-processor', TapeProcessor);
