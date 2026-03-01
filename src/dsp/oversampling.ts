/**
 * Oversampler with FIR anti-aliasing filters.
 *
 * Uses a windowed-sinc (Blackman window) lowpass FIR to prevent aliasing
 * when nonlinear processing (e.g. hysteresis) is applied at higher sample
 * rates.
 */

export class Oversampler {
  /** Oversampling factor (1 = bypass, 2 or 4). */
  readonly factor: number;

  /** FIR filter kernel for upsample (DC gain = factor). */
  private readonly upsampleKernel: Float64Array;

  /** FIR filter kernel for downsample (DC gain = 1). */
  private readonly downsampleKernel: Float64Array;

  /** Delay-line state for the upsample FIR. */
  private upsampleState: Float64Array;

  /** Delay-line state for the downsample FIR. */
  private downsampleState: Float64Array;

  /**
   * @param factor  Oversampling factor: 1 (bypass), 2, or 4.
   */
  constructor(factor: number) {
    this.factor = factor;

    if (factor <= 1) {
      // Bypass — no filter needed.
      this.upsampleKernel = new Float64Array(0);
      this.downsampleKernel = new Float64Array(0);
      this.upsampleState = new Float64Array(0);
      this.downsampleState = new Float64Array(0);
      return;
    }

    // ---- Design windowed-sinc lowpass FIR ----
    const N = 31 * factor + 1; // filter length (odd)
    const cutoff = 1 / factor; // normalized to oversampled Nyquist
    const baseKernel = new Float64Array(N);

    const mid = (N - 1) / 2;

    for (let i = 0; i < N; i++) {
      // Blackman window
      const w =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (N - 1));

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
    // Upsampling inserts (factor-1) zeros between each sample, reducing the
    // level by 1/factor.  Scaling the filter by `factor` compensates for this.
    const upsampleScale = factor / dcGain;
    this.upsampleKernel = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.upsampleKernel[i] = baseKernel[i] * upsampleScale;
    }

    // Downsample kernel: normalize DC gain to 1 (anti-alias only).
    const downsampleScale = 1 / dcGain;
    this.downsampleKernel = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.downsampleKernel[i] = baseKernel[i] * downsampleScale;
    }

    this.upsampleState = new Float64Array(N);
    this.downsampleState = new Float64Array(N);
  }

  /**
   * Upsample the input buffer by the oversampling factor.
   *
   * Zero-stuffs (factor-1) zeros between each input sample, then applies
   * the FIR lowpass filter.
   *
   * @returns Buffer of length `input.length * factor`.
   */
  upsample(input: Float32Array): Float32Array {
    if (this.factor <= 1) {
      return input;
    }

    const factor = this.factor;
    const stuffed = new Float32Array(input.length * factor);

    // Zero-stuff: place each input sample at every `factor`th position.
    for (let i = 0; i < input.length; i++) {
      stuffed[i * factor] = input[i];
    }

    // Apply FIR lowpass to the zero-stuffed signal.
    const output = new Float32Array(stuffed.length);
    this.applyFir(stuffed, output, this.upsampleState, this.upsampleKernel);

    return output;
  }

  /**
   * Downsample the input buffer by the oversampling factor.
   *
   * Applies the FIR lowpass anti-alias filter, then decimates (keeps every
   * `factor`th sample).
   *
   * @returns Buffer of length `floor(input.length / factor)`.
   */
  downsample(input: Float32Array): Float32Array {
    if (this.factor <= 1) {
      return input;
    }

    const factor = this.factor;

    // Apply FIR lowpass (anti-alias) before decimation.
    const filtered = new Float32Array(input.length);
    this.applyFir(input, filtered, this.downsampleState, this.downsampleKernel);

    // Decimate: take every `factor`th sample.
    const outLen = Math.floor(input.length / factor);
    const output = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      output[i] = filtered[i * factor];
    }

    return output;
  }

  /** Clear all filter delay-line states. */
  reset(): void {
    this.upsampleState.fill(0);
    this.downsampleState.fill(0);
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Apply the FIR filter via direct convolution with a delay line.
   *
   * For each input sample:
   *   1. Shift the delay line right by one position.
   *   2. Insert the new sample at the beginning.
   *   3. Compute the dot product of the delay line and the kernel.
   */
  private applyFir(
    input: Float32Array,
    output: Float32Array,
    state: Float64Array,
    kernel: Float64Array,
  ): void {
    const N = kernel.length;

    for (let i = 0; i < input.length; i++) {
      // Shift delay line right
      for (let j = N - 1; j > 0; j--) {
        state[j] = state[j - 1];
      }
      state[0] = input[i];

      // Dot product with kernel
      let sum = 0;
      for (let j = 0; j < N; j++) {
        sum += state[j] * kernel[j];
      }
      output[i] = sum;
    }
  }
}
