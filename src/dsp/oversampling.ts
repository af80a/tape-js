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

/** In-place radix-2 FFT. x_re and x_im must be length N = 2^k. */
function fft(x_re: Float64Array, x_im: Float64Array, inverse = false) {
  const N = x_re.length;
  // bit reversal
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      let t = x_re[j]; x_re[j] = x_re[i]; x_re[i] = t;
      t = x_im[j]; x_im[j] = x_im[i]; x_im[i] = t;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  // Cooley-Tukey
  for (let L = 2; L <= N; L <<= 1) {
    const halfL = L >> 1;
    const w_m_re = Math.cos(2 * Math.PI / L * (inverse ? 1 : -1));
    const w_m_im = Math.sin(2 * Math.PI / L * (inverse ? 1 : -1));
    for (let k = 0; k < N; k += L) {
      let w_re = 1, w_im = 0;
      for (let i = 0; i < halfL; i++) {
        const u_re = x_re[k + i];
        const u_im = x_im[k + i];
        const t_re = w_re * x_re[k + i + halfL] - w_im * x_im[k + i + halfL];
        const t_im = w_re * x_im[k + i + halfL] + w_im * x_re[k + i + halfL];
        x_re[k + i] = u_re + t_re;
        x_im[k + i] = u_im + t_im;
        x_re[k + i + halfL] = u_re - t_re;
        x_im[k + i + halfL] = u_im - t_im;
        const next_w_re = w_re * w_m_re - w_im * w_m_im;
        w_im = w_re * w_m_im + w_im * w_m_re;
        w_re = next_w_re;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) {
      x_re[i] /= N;
      x_im[i] /= N;
    }
  }
}

/** Convert a linear-phase FIR kernel to minimum-phase via real cepstrum. */
function linearToMinimumPhase(h: Float64Array): Float64Array {
  // Pad to next power of 2 at least 4x the length to avoid time aliasing
  let Nfft = 1;
  while (Nfft < h.length * 4) Nfft <<= 1;
  
  const x_re = new Float64Array(Nfft);
  const x_im = new Float64Array(Nfft);
  x_re.set(h);
  
  // 1. FFT
  fft(x_re, x_im, false);
  
  // 2. Log magnitude
  for (let i = 0; i < Nfft; i++) {
    const mag = Math.sqrt(x_re[i]*x_re[i] + x_im[i]*x_im[i]);
    x_re[i] = Math.log(Math.max(1e-12, mag));
    x_im[i] = 0;
  }
  
  // 3. IFFT to get real cepstrum
  fft(x_re, x_im, true);
  
  // 4. Multiply cepstrum by causal window
  x_re[0] *= 1;
  x_re[Nfft/2] *= 1; // Nyquist bin
  for (let i = 1; i < Nfft/2; i++) {
    x_re[i] *= 2;
    x_im[i] = 0;
  }
  for (let i = Nfft/2 + 1; i < Nfft; i++) {
    x_re[i] = 0;
    x_im[i] = 0;
  }
  
  // 5. FFT
  fft(x_re, x_im, false);
  
  // 6. Complex exponential
  for (let i = 0; i < Nfft; i++) {
    const exp_re = Math.exp(x_re[i]);
    const cos_im = Math.cos(x_im[i]);
    const sin_im = Math.sin(x_im[i]);
    x_re[i] = exp_re * cos_im;
    x_im[i] = exp_re * sin_im;
  }
  
  // 7. IFFT to get minimum-phase impulse response
  fft(x_re, x_im, true);
  
  // Extract and return the first h.length samples
  return x_re.slice(0, h.length);
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

    // Convert linear-phase kernel to minimum-phase to eliminate pre-ringing
    const minPhaseKernel = linearToMinimumPhase(baseKernel);

    // Compute unnormalized DC gain.
    let dcGain = 0;
    for (let i = 0; i < N; i++) {
      dcGain += minPhaseKernel[i];
    }

    // Upsample kernel: normalize DC gain to `factor`.
    const upsampleScale = factor / dcGain;
    const upsampleKernel = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      upsampleKernel[i] = minPhaseKernel[i] * upsampleScale;
    }

    // Downsample kernel: normalize DC gain to 1 (anti-alias only).
    const downsampleScale = 1 / dcGain;
    this.downsampleKernel = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.downsampleKernel[i] = minPhaseKernel[i] * downsampleScale;
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
    // Double-buffer: size 2N lets convolution read state[idx + j] without inner-loop modulo.
    // Mirror each written sample at state[idx] and state[idx + N] so the window
    // [idx, idx+N) is always valid regardless of wrap position.
    this.downsampleState = new Float64Array(N * 2);
    
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
    const state = this.downsampleState; // size 2*N (double-buffer)
    let stateIdx = this.downsampleStateIdx;

    for (let i = 0; i < outLen; i++) {
      // Insert 'factor' new high-rate samples into the double-buffer circular buffer.
      // Each sample is written at stateIdx and again at stateIdx + N so the
      // convolution window [stateIdx, stateIdx+N) is always contiguous — no modulo
      // needed in the inner product loop below.
      for (let f = 0; f < factor; f++) {
        if (--stateIdx < 0) stateIdx += N;
        const v = input[i * factor + f];
        state[stateIdx] = v;
        state[stateIdx + N] = v;
      }

      // FIR dot product — inner loop has no modulo (stateIdx + j always in [0, 2N))
      let sum = 0;
      for (let j = 0; j < N; j++) {
        sum += state[stateIdx + j] * kernel[j];
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
