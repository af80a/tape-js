/**
 * Transformer Model — simulates audio transformer characteristics:
 *
 * 1. LF coupling: High-pass filter models finite primary inductance
 *    that rolls off low frequencies.
 * 2. Core saturation: Soft clipping via tanh with asymmetry for
 *    even-harmonic generation (characteristic of transformer distortion).
 * 3. HF resonant rolloff: Low-pass filter with adjustable Q models
 *    the resonant peak and subsequent rolloff at high frequencies.
 */

import {
  BiquadFilter,
  designHighpass,
  designLowpass,
} from './biquad';

export interface TransformerOptions {
  /** LF coupling frequency in Hz (default: 20) */
  lfCutoff?: number;
  /** HF resonant rolloff frequency in Hz, clamped to 0.45*fs (default: 50000) */
  hfResonance?: number;
  /** Q of HF resonance (default: 0.8) */
  hfQ?: number;
  /** Drive into core saturation (default: 1.0) */
  satAmount?: number;
}

export class TransformerModel {
  private readonly hpf: BiquadFilter;
  private readonly lpf: BiquadFilter;
  private readonly satGain: number;

  constructor(sampleRate: number, options?: TransformerOptions) {
    const lfCutoff = options?.lfCutoff ?? 20;
    const hfResonance = Math.min(options?.hfResonance ?? 50000, 0.45 * sampleRate);
    const hfQ = options?.hfQ ?? 0.8;
    const satAmount = options?.satAmount ?? 1.0;

    this.satGain = satAmount;

    // HPF at lfCutoff, Q=0.5 — models LF coupling from finite primary inductance
    this.hpf = new BiquadFilter(designHighpass(lfCutoff, sampleRate, 0.5));

    // LPF at hfResonance, Q=hfQ — models HF rolloff with resonant peak
    this.lpf = new BiquadFilter(designLowpass(hfResonance, sampleRate, hfQ));
  }

  /**
   * Process a single sample through the transformer model.
   *
   * Signal chain: HPF -> Core Saturation -> LPF
   */
  process(input: number): number {
    // 1. HPF (LF coupling)
    let x = this.hpf.process(input);

    // 2. Core saturation — unity gain for small signals, soft clip at high levels
    if (Math.abs(x) >= 0.001) {
      const driven = x * this.satGain;
      // tanh(x)/x → 1 as x→0, so this preserves unity gain at low levels
      x = Math.tanh(driven) / this.satGain;
      // Asymmetry: add subtle even harmonics
      x += 0.02 * driven * driven * Math.sign(driven);
    }

    // 3. LPF (HF rolloff)
    x = this.lpf.process(x);

    return x;
  }

  /** Reset both biquad filters (clear delay states). */
  reset(): void {
    this.hpf.reset();
    this.lpf.reset();
  }
}
