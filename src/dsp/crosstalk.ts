/**
 * Inter-channel magnetic crosstalk model.
 *
 * Models two physical coupling mechanisms between adjacent tape tracks:
 *
 * 1. Magnetic fringing — recorded magnetization on one track produces
 *    fringing fields that decay exponentially across the guard band.
 *    Long wavelengths (low frequencies) couple more because their fields
 *    extend further laterally. This follows the same exponential decay
 *    as the Wallace spacing loss: coupling ∝ exp(-2π * d / λ) where d
 *    is the guard band width. Modeled as a 1-pole LPF on the bleed path.
 *
 * 2. Capacitive/inductive head coupling — adjacent head windings exhibit
 *    capacitive coupling that rises at ~+6 dB/octave. Modeled as the
 *    complementary HPF (input minus the LPF) at a lower level.
 *
 * The combined crosstalk has a "bathtub" shape: worst at LF and HF
 * extremes, best separation around 1-3 kHz (which is why manufacturers
 * spec crosstalk at 1 kHz).
 *
 * Typical real-world levels (at 1 kHz):
 *   Ampex ATR-102:     -45 dB  (amount ≈ 0.0056)
 *   Studer A810 stereo: -55 dB  (amount ≈ 0.0018)
 *   Studer A810 2-trk:  -65 dB  (amount ≈ 0.0006)
 *
 * Both tracks are read simultaneously at the same tape position, so
 * there is no physical propagation delay for playback-mode crosstalk.
 *
 * Supports N channels: each track couples only to its immediate
 * neighbors (adjacent tracks on the tape head), matching physical
 * fringing field geometry.
 */
export class CrosstalkModel {
  // Magnetic fringing LPF state per channel
  private fringeLpf: number[] = [];
  private fringeLpfCoeff: number;

  // Overall amount (linear, approximate level at 1 kHz reference)
  private amount: number;
  // Capacitive path level relative to magnetic path.
  // Typically 10-15 dB below fringing at HF crossover.
  private capRatio = 0.18;

  // Scratch buffer for per-sample bleed accumulation (avoids alloc in process)
  private bleed: number[] = [];

  constructor(fs: number, maxChannels = 8) {
    // Magnetic fringing LPF: models exponential field decay across guard band.
    // Time constant 0.5ms → f_c = 1/(2π*0.0005) ≈ 318 Hz.
    this.fringeLpfCoeff = Math.exp(-1 / (fs * 0.0005));

    // Default: ATR-102 level (-45 dB ≈ 0.0056 linear)
    this.amount = 0.006;

    // Pre-allocate for up to maxChannels
    this.fringeLpf = new Array(maxChannels).fill(0);
    this.bleed = new Array(maxChannels).fill(0);
  }

  setAmount(amount: number) {
    // Allow aggressive creative values but keep bleed below unity for stability.
    this.amount = Math.max(0, Math.min(0.5, amount));
  }

  process(blocks: Float32Array[]) {
    const numCh = blocks.length;
    if (numCh < 2) return;

    const len = blocks[0].length;
    const amount = this.amount;
    const coeff = this.fringeLpfCoeff;
    const oneMinusCoeff = 1 - coeff;
    const capRatio = this.capRatio;
    const lpf = this.fringeLpf;
    const bleed = this.bleed;

    for (let i = 0; i < len; i++) {
      // Compute bleed contribution from each channel to its neighbors
      for (let ch = 0; ch < numCh; ch++) {
        const x = blocks[ch][i];

        // Update fringing LPF for this channel
        lpf[ch] = lpf[ch] * coeff + x * oneMinusCoeff;

        // Capacitive HPF (complementary)
        const hpf = x - lpf[ch];

        // Combined bleed signal from this channel
        bleed[ch] = (lpf[ch] + hpf * capRatio) * amount;
      }

      // Apply bleed from adjacent channels only (physical neighbor coupling)
      for (let ch = 0; ch < numCh; ch++) {
        let incoming = 0;
        if (ch > 0) incoming += bleed[ch - 1];
        if (ch < numCh - 1) incoming += bleed[ch + 1];
        blocks[ch][i] += incoming;
      }
    }
  }
}
