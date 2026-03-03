/**
 * Oversampler with Polyphase FIR anti-aliasing filters.
 *
 * Uses a Kaiser-windowed sinc lowpass FIR to prevent aliasing when nonlinear
 * processing is applied at higher sample rates. Kaiser provides superior
 * control over the stopband-attenuation/transition-width tradeoff compared
 * to fixed windows (Blackman, Hann), achieving ~100dB stopband rejection
 * suitable for 24-bit audio.
 * 
 * Implemented using a highly optimized polyphase structure with circular buffers
 * to eliminate unnecessary zero-multiplications and array shifting.
 */

/** Zeroth-order modified Bessel function I0(x) via polynomial series. */
function besselI0(x: number): number {
  const halfX = x * 0.5;
  let term = 1.0;
  let sum = 1.0;
  for (let k = 1; k <= 25; k++) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

export class Oversampler {
  /** Oversampling factor (1 = bypass, 2 or 4). */
  readonly factor: number;

  /** Number of taps per phase in the polyphase filters. */
  private readonly tapsPerPhase: number;

  /** 
   * Polyphase kernels for upsampling.
   * [phase][tap]
   */
  private readonly upsamplePhases: Float64Array[];

  /**
   * Standard FIR kernel for downsampling.
   * (Downsampling uses a strided standard FIR over the high-rate input).
   */
  private readonly downsampleKernel: Float64Array;

  /** Circular buffer state for upsampling (runs at base rate). */
  private upsampleState: Float64Array;
  private upsampleStateIdx: number = 0;

  /** Circular buffer state for downsampling (runs at oversampled rate). */
  private downsampleState: Float64Array;
  private downsampleStateIdx: number = 0;

  /** Pre-allocated scratch buffers for zero-allocation processing. */
  private upsampleOutput: Float32Array;
  private downsampleOutput: Float32Array;

  /**
   * @param factor  Oversampling factor: 1 (bypass), 2, or 4.
   * @param maxInputLength  Maximum input length to pre-allocate for (default 1).
   */
  constructor(factor: number, maxInputLength = 1) {
    this.factor = factor;

    if (factor <= 1) {
      // Bypass — no filter needed.
      this.tapsPerPhase = 0;
      this.upsamplePhases = [];
      this.downsampleKernel = new Float64Array(0);
      this.upsampleState = new Float64Array(0);
      this.downsampleState = new Float64Array(0);
      this.upsampleOutput = new Float32Array(0);
      this.downsampleOutput = new Float32Array(0);
      return;
    }

    // ---- Design Kaiser-windowed sinc lowpass FIR ----
    const N = 31 * factor + 1; // filter length (odd)
    const cutoff = 1 / factor; // normalized to oversampled Nyquist
    const baseKernel = new Float64Array(N);

    const mid = (N - 1) / 2;
    const kaiserBeta = 10.0; // ~100dB stopband attenuation (24-bit quality)
    const I0beta = besselI0(kaiserBeta);

    for (let i = 0; i < N; i++) {
      // Kaiser window
      const nNorm = (2 * i) / (N - 1) - 1; // normalized to [-1, 1]
      const sqrtArg = 1 - nNorm * nNorm;
      const w = besselI0(kaiserBeta * Math.sqrt(Math.max(0, sqrtArg))) / I0beta;

      // Sinc function
      const x = i - mid;
      let sinc: number;
      if (x === 0) {
        sinc = 1;
      } else {
        const arg = Math.PI * cutoff * x;
        sinc = Math.sin(arg) / arg;
      }

      baseKernel[i] = w * sinc;
    }

    // Compute unnormalized DC gain.
    let dcGain = 0;
    for (let i = 0; i < N; i++) {
      dcGain += baseKernel[i];
    }

    // Upsample kernel: normalize DC gain to `factor`.
    const upsampleScale = factor / dcGain;
    const upsampleKernel = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      upsampleKernel[i] = baseKernel[i] * upsampleScale;
    }

    // Downsample kernel: normalize DC gain to 1 (anti-alias only).
    const downsampleScale = 1 / dcGain;
    this.downsampleKernel = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.downsampleKernel[i] = baseKernel[i] * downsampleScale;
    }

    // ---- Decompose Upsample Kernel into Polyphase Components ----
    this.tapsPerPhase = Math.ceil(N / factor);
    
    // Pad kernel to a multiple of factor to make phase arrays equal length
    const paddedUpsampleKernel = new Float64Array(factor * this.tapsPerPhase);
    paddedUpsampleKernel.set(upsampleKernel);

    this.upsamplePhases = [];
    for (let p = 0; p < factor; p++) {
      const phase = new Float64Array(this.tapsPerPhase);
      for (let t = 0; t < this.tapsPerPhase; t++) {
        phase[t] = paddedUpsampleKernel[t * factor + p];
      }
      this.upsamplePhases.push(phase);
    }

    // States are now circular buffers
    this.upsampleState = new Float64Array(this.tapsPerPhase);
    this.downsampleState = new Float64Array(N);
    
    this.upsampleStateIdx = 0;
    this.downsampleStateIdx = 0;

    // Pre-allocate scratch buffers
    this.upsampleOutput = new Float32Array(maxInputLength * factor);
    this.downsampleOutput = new Float32Array(maxInputLength);
  }

  /**
   * Upsample the input buffer by the oversampling factor using a polyphase FIR.
   *
   * @returns Buffer of length `input.length * factor`.
   */
  upsample(input: Float32Array): Float32Array {
    if (this.factor <= 1) return input;

    const factor = this.factor;
    const output = this.upsampleOutput;
    const state = this.upsampleState;
    const phases = this.upsamplePhases;
    const taps = this.tapsPerPhase;
    let stateIdx = this.upsampleStateIdx;

    for (let i = 0; i < input.length; i++) {
      // Insert new sample into circular buffer (moving backward)
      stateIdx = (stateIdx - 1 + taps) % taps;
      state[stateIdx] = input[i];

      // Compute each phase output
      for (let p = 0; p < factor; p++) {
        let sum = 0;
        const phase = phases[p];
        for (let t = 0; t < taps; t++) {
          sum += state[(stateIdx + t) % taps] * phase[t];
        }
        output[i * factor + p] = sum;
      }
    }

    this.upsampleStateIdx = stateIdx;
    return output;
  }

  /**
   * Downsample the input buffer by the oversampling factor.
   *
   * @returns Buffer of length `floor(input.length / factor)`.
   */
  downsample(input: Float32Array): Float32Array {
    if (this.factor <= 1) return input;

    const factor = this.factor;
    const outLen = Math.floor(input.length / factor);
    const output = this.downsampleOutput;
    const kernel = this.downsampleKernel;
    const N = kernel.length;
    const state = this.downsampleState;
    let stateIdx = this.downsampleStateIdx;

    for (let i = 0; i < outLen; i++) {
      // Insert 'factor' new high-rate samples into the circular buffer
      for (let f = 0; f < factor; f++) {
        stateIdx = (stateIdx - 1 + N) % N;
        state[stateIdx] = input[i * factor + f];
      }

      // Compute single FIR dot product for the kept sample
      let sum = 0;
      for (let j = 0; j < N; j++) {
        sum += state[(stateIdx + j) % N] * kernel[j];
      }
      output[i] = sum;
    }

    this.downsampleStateIdx = stateIdx;
    return output;
  }

  /** Clear all filter delay-line states. */
  reset(): void {
    this.upsampleState.fill(0);
    this.downsampleState.fill(0);
    this.upsampleStateIdx = 0;
    this.downsampleStateIdx = 0;
  }
}
