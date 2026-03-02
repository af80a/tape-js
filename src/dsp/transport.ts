/**
 * Transport model — variable delay line with cubic Lagrange
 * interpolation for wow and flutter simulation.
 *
 * Wow is a slow (~1.2 Hz) pitch modulation caused by mechanical
 * irregularities in the tape transport. Flutter is a faster
 * (~6.5 Hz) modulation from capstan and guide roller vibrations.
 *
 * Depth calibration is physics-based: the 0-1 control maps linearly
 * to peak speed deviation percentage. At depth=1.0, wow produces
 * 0.5% and flutter produces 0.2% peak speed deviation — consumer
 * cassette territory. Professional machines operate at 0.02-0.06%.
 *
 * Per-channel phase offsets simulate the slightly different
 * modulation each track receives from mechanical imperfections.
 * A secondary flutter harmonic adds realistic capstan content.
 */

const TWO_PI = 2 * Math.PI;

// Maximum peak speed deviation at depth=1.0 (fraction, not percent).
// These calibration constants ensure preset defaults produce physically
// accurate wow/flutter matching real machine specs:
//   Studer A810 at 15 ips: ≤0.05% combined (DIN weighted)
//   Ampex ATR-102 at 15 ips: ≤0.04% combined (NAB)
//   MCI JH-24 at 15 ips: ≤0.04% combined (DIN weighted)
// At depth=1.0: 0.5% wow / 0.2% flutter = clearly audible, lo-fi territory.
const WOW_MAX_DEVIATION = 0.005;
const FLUTTER_MAX_DEVIATION = 0.002;

// Minimum configurable rates (Hz) — used for buffer sizing
const MIN_WOW_RATE_HZ = 0.5;
const MIN_FLUTTER_RATE_HZ = 3;

const WOW_PHASE_OFFSETS = [0, Math.PI * 0.37];
const FLUTTER_PHASE_OFFSETS = [Math.PI * 0.19, Math.PI * 0.83];

export class TransportModel {
  private readonly baseDelay: number;
  private readonly bufferSize: number;
  private readonly buffer: Float32Array;

  private wowRate: number;
  private flutterRate: number;
  private readonly channelIndex: number;
  private readonly sampleRate: number;

  private readonly initialWowPhase: number;
  private readonly initialFlutterPhase: number;

  private wowPhase: number;
  private flutterPhase: number;
  private wowDepth = 0;
  private flutterDepth = 0;
  private writeIdx = 0;

  // Precomputed delay amplitudes (samples) from speed deviation physics:
  // delayAmp = maxDeviation / angularRate  (where angularRate = rad/sample)
  private wowDelayAmp: number;
  private flutterDelayAmp: number;

  // Noise-based modulation state
  private prngState: number;
  private wowNoiseState = 0;
  private flutterNoiseState = 0;
  private readonly wowNoiseCoeff: number;
  private readonly flutterNoiseCoeff: number;

  // Wow frequency drift: very slow modulation of wow rate simulating
  // reel diameter change as tape moves from supply to takeup reel.
  private baseWowRate: number;
  private driftPhase = 0;
  private readonly driftRate: number;  // ~0.05 Hz (period ~20s)
  private readonly driftDepth: number; // ±25% frequency variation

  /**
   * @param sampleRate    Audio sample rate in Hz
   * @param channelIndex  Channel index for stereo phase detuning (default 0)
   */
  constructor(sampleRate: number, channelIndex = 0) {
    this.sampleRate = sampleRate;

    // Size buffer for worst-case delay modulation at lowest configurable rates.
    // Combined waveform peak factor ~1.3 (sine + harmonic + noise),
    // drift adds up to ±25%, plus 10% safety margin.
    const maxWowAmp = WOW_MAX_DEVIATION / (TWO_PI * MIN_WOW_RATE_HZ / sampleRate);
    const maxFlutterAmp = FLUTTER_MAX_DEVIATION / (TWO_PI * MIN_FLUTTER_RATE_HZ / sampleRate);
    const maxModulation = Math.ceil((maxWowAmp * 1.3 * 1.25 + maxFlutterAmp * 1.3) * 1.1);
    this.baseDelay = maxModulation;
    this.bufferSize = 2 * maxModulation + 4; // symmetric range + interpolation headroom
    this.buffer = new Float32Array(this.bufferSize);

    this.baseWowRate = TWO_PI * 1.2 / sampleRate;
    this.wowRate = this.baseWowRate;
    this.flutterRate = TWO_PI * 6.5 / sampleRate;

    // Precompute delay amplitudes from speed deviation calibration
    this.wowDelayAmp = WOW_MAX_DEVIATION / this.baseWowRate;
    this.flutterDelayAmp = FLUTTER_MAX_DEVIATION / this.flutterRate;

    // Wow drift: ~20 second period, ±25% rate variation
    // Simulates reel diameter change as tape moves between reels.
    this.driftRate = TWO_PI * 0.05 / sampleRate;
    this.driftDepth = 0.25;

    this.channelIndex = channelIndex;
    this.initialWowPhase = WOW_PHASE_OFFSETS[channelIndex] ?? 0;
    this.initialFlutterPhase = FLUTTER_PHASE_OFFSETS[channelIndex] ?? 0;
    this.wowPhase = this.initialWowPhase;
    this.flutterPhase = this.initialFlutterPhase;

    // Filtered noise for non-periodic modulation character.
    // Wow noise: lowpass at ~2 Hz captures slow mechanical drift.
    // Flutter noise: lowpass at ~12 Hz captures capstan jitter bandwidth.
    this.wowNoiseCoeff = 1 - Math.exp(-TWO_PI * 2 / sampleRate);
    this.flutterNoiseCoeff = 1 - Math.exp(-TWO_PI * 12 / sampleRate);

    // Seed xorshift32 PRNG per-channel for stereo decorrelation
    this.prngState = 1 + channelIndex * 65537;
  }

  /** Set wow depth (clamped to 0-1). */
  setWow(v: number): void {
    this.wowDepth = Math.max(0, Math.min(1, v));
  }

  /** Set flutter depth (clamped to 0-1). */
  setFlutter(v: number): void {
    this.flutterDepth = Math.max(0, Math.min(1, v));
  }

  /** Set wow LFO rate in Hz (e.g., 0.5-3.0 Hz). */
  setWowRate(hz: number): void {
    this.baseWowRate = TWO_PI * hz / this.sampleRate;
    this.wowRate = this.baseWowRate;
    this.wowDelayAmp = WOW_MAX_DEVIATION / this.baseWowRate;
  }

  /** Set flutter LFO rate in Hz (e.g., 3-15 Hz). */
  setFlutterRate(hz: number): void {
    this.flutterRate = TWO_PI * hz / this.sampleRate;
    this.flutterDelayAmp = FLUTTER_MAX_DEVIATION / this.flutterRate;
  }

  /** Xorshift32 PRNG returning a value in [-1, 1]. */
  private nextNoise(): number {
    let x = this.prngState | 0;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.prngState = x;
    return (x | 0) / 0x7FFFFFFF;
  }

  /** Process a single sample through the variable delay line. */
  process(input: number): number {
    // 1. Write input to circular buffer
    this.buffer[this.writeIdx] = input;

    // 2. Generate filtered noise for non-periodic modulation
    this.wowNoiseState += this.wowNoiseCoeff * (this.nextNoise() - this.wowNoiseState);
    this.flutterNoiseState += this.flutterNoiseCoeff * (this.nextNoise() - this.flutterNoiseState);

    // 3. Calculate modulated delay from physics-based speed deviation
    // Delay amplitude (samples) = peak_speed_deviation / angular_rate
    // Sine provides the dominant spectral peak; noise adds cycle-to-cycle variation
    const wowSine = Math.sin(this.wowPhase) * 0.7;
    const wowNoise = this.wowNoiseState * 0.3;
    const wowMod = (wowSine + wowNoise) * this.wowDepth * this.wowDelayAmp;

    const flutterSine = Math.sin(this.flutterPhase) * 0.7;
    const flutterHarmonic =
      Math.sin(this.flutterPhase * 2 + this.channelIndex * 0.47) * 0.35 * 0.7;
    const flutterNoise = this.flutterNoiseState * 0.3;
    const flutterMod =
      (flutterSine + flutterHarmonic + flutterNoise) *
      this.flutterDepth *
      this.flutterDelayAmp;

    const delay = this.baseDelay + wowMod + flutterMod;

    // 4. Advance LFO phases with wow frequency drift
    // Drift modulates the wow rate by ±15% over a ~50 second period,
    // simulating reel diameter change as tape moves between reels.
    const driftMod = 1 + this.driftDepth * Math.sin(this.driftPhase);
    this.wowPhase += this.baseWowRate * driftMod;
    if (this.wowPhase >= TWO_PI) this.wowPhase -= TWO_PI;
    this.flutterPhase += this.flutterRate;
    if (this.flutterPhase >= TWO_PI) this.flutterPhase -= TWO_PI;
    this.driftPhase += this.driftRate;
    if (this.driftPhase >= TWO_PI) this.driftPhase -= TWO_PI;

    // 4. Read from buffer with cubic Lagrange interpolation
    const readPos = this.writeIdx - delay;
    const readFloor = Math.floor(readPos);
    const frac = readPos - readFloor;

    const s0 = this.readBuffer(readFloor - 1);
    const s1 = this.readBuffer(readFloor);
    const s2 = this.readBuffer(readFloor + 1);
    const s3 = this.readBuffer(readFloor + 2);

    // Cubic Lagrange interpolation
    const output =
      s1 +
      0.5 *
        frac *
        (s2 - s0 +
          frac *
            (2 * s0 - 5 * s1 + 4 * s2 - s3 +
              frac * (3 * (s1 - s2) + s3 - s0)));

    // 5. Advance write index (wrap at bufferSize)
    this.writeIdx = (this.writeIdx + 1) % this.bufferSize;

    return output;
  }

  /** Read from the circular buffer with safe index wrapping. */
  private readBuffer(idx: number): number {
    return this.buffer[
      ((idx % this.bufferSize) + this.bufferSize) % this.bufferSize
    ];
  }

  /** Reset buffer, write index, LFO phases, and noise filter states. */
  reset(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.wowPhase = this.initialWowPhase;
    this.flutterPhase = this.initialFlutterPhase;
    this.wowNoiseState = 0;
    this.flutterNoiseState = 0;
    this.driftPhase = 0;
  }
}
