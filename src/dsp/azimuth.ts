/**
 * Playback head azimuth error model.
 *
 * When the playback head gap is not perfectly perpendicular to the
 * direction of tape travel, it is tilted by a small angle θ. This
 * causes two distinct effects:
 *
 * 1. **Inter-channel time delay** — the tilted gap reads one track
 *    before the other. For tracks with center-to-center spacing d,
 *    the delay between adjacent channels is:
 *
 *        Δt = d · tan(θ) / v
 *
 *    where v is tape speed. Channel 0 is the reference; channel N
 *    receives N · Δt of additional delay. This fixed time offset
 *    produces a frequency-dependent phase shift φ(f) = 2π·f·Δt
 *    that affects stereo imaging and causes comb filtering on mono sum.
 *
 * 2. **Per-track sinc rolloff** — different parts of a single track's
 *    width are read at slightly different longitudinal positions:
 *
 *        L(f) = sinc(W · f · tan(θ) / v)
 *
 *    where W is track width. For well-calibrated machines (θ < 6 arcmin),
 *    the first null is above 50 kHz for all formats, so this loss is
 *    negligible at audio frequencies and is not modeled here.
 *
 * **Azimuth drift**: The effective azimuth angle is not constant.
 * Tape weave (lateral tape motion from guide roller runout, reel
 * eccentricity, and pack irregularities) causes slow modulation
 * of the effective head-to-tape angle. This is modeled as a sum
 * of two LFOs at incommensurate rates for non-periodic character:
 *   - Slow component (~0.11 Hz): reel eccentricity, pack effects
 *   - Medium component (~0.73 Hz): guide roller runout
 *
 * The drift modulates the azimuth angle around the static value,
 * creating a subtle stereo animation that is one of the defining
 * characteristics of the "tape sound" on stereo material.
 *
 * Typical inter-channel delays at 15 ips:
 *   1 arcmin, Studer A810 (d=4.22mm):  3.2 µs  (0.15 samples @ 48kHz)
 *   3 arcmin, Studer A810:             9.7 µs  (0.46 samples)
 *   1 arcmin, Ampex ATR-102 (d=6.86mm): 5.2 µs (0.25 samples)
 *   3 arcmin, MCI JH-24 (d=2.13mm):   2.4 µs  (0.12 samples)
 *
 * Implementation: cubic Lagrange interpolation on a small circular
 * buffer, identical to the transport model's delay line but with
 * much smaller delay range (max ~5 samples vs transport's ~1000).
 */

const TWO_PI = 2 * Math.PI;
const MAX_AZIMUTH_ARCMIN = 30;

// 1 arcminute in radians
const ARCMIN_TO_RAD = Math.PI / (180 * 60);

export class AzimuthModel {
  private readonly sampleRate: number;
  private readonly channelIndex: number;

  // Track geometry (meters)
  private trackSpacing: number;  // center-to-center between adjacent tracks

  // Tape speed (meters per second)
  private tapeSpeedMps: number;

  // Azimuth state
  private staticAzimuth = 0;  // static error in radians
  private driftDepth = 0;     // drift amplitude in radians

  // Drift LFOs — two incommensurate frequencies for non-periodic modulation.
  // Both channels must produce identical angles (single physical head),
  // so initial phases are channel-independent (always 0).
  private driftPhase1 = 0;
  private driftPhase2 = 0;
  private readonly driftRate1: number;  // ~0.11 Hz (reel eccentricity)
  private readonly driftRate2: number;  // ~0.73 Hz (guide roller runout)

  // Delay line (circular buffer with cubic Lagrange interpolation)
  private readonly buffer: Float64Array;
  private readonly bufferSize: number;
  private writeIdx = 0;
  // Base delay in samples — positions the read pointer in the middle
  // of the buffer so we can accommodate both positive and negative
  // delay modulation from drift.
  private readonly baseDelay: number;

  /**
   * @param sampleRate     Audio sample rate in Hz
   * @param channelIndex   Channel index (0 = reference, no delay)
   * @param tapeSpeedIps   Tape speed in inches per second
   * @param trackSpacing   Center-to-center track spacing in meters
   */
  constructor(
    sampleRate: number,
    channelIndex: number,
    tapeSpeedIps: number,
    trackSpacing: number,
  ) {
    this.sampleRate = sampleRate;
    this.channelIndex = channelIndex;
    this.trackSpacing = trackSpacing;
    this.tapeSpeedMps = tapeSpeedIps * 0.0254;

    // Drift LFO rates — incommensurate to avoid exact periodicity
    this.driftRate1 = TWO_PI * 0.11 / sampleRate;
    this.driftRate2 = TWO_PI * 0.73 / sampleRate;

    // Buffer sizing: creative range up to 30 arcmin, widest spacing (6.86mm),
    // slowest speed (3.75 ips = 0.095 m/s), with ±20% drift headroom:
    //   delay ≈ 6.86e-3 * tan(30 arcmin) / 0.095 * 48000 ≈ 30.2 samples
    // With drift: ~36.2 samples. Add baseDelay=8 and interpolation headroom.
    // 64 samples safely covers this range.
    this.baseDelay = 8;
    this.bufferSize = 64;
    this.buffer = new Float64Array(this.bufferSize);
  }

  /**
   * Set the static azimuth error.
   * @param arcminutes  Error magnitude in arcminutes (0 = perfect, 30 = creative extreme)
   */
  setAzimuth(arcminutes: number): void {
    this.staticAzimuth = Math.max(0, Math.min(MAX_AZIMUTH_ARCMIN, arcminutes)) * ARCMIN_TO_RAD;
    // Drift depth tracks static error: ~20% of static value plus
    // a small constant floor (0.1 arcmin) so there's always some
    // subtle tape weave even on a "perfectly" aligned machine.
    this.driftDepth = (this.staticAzimuth * 0.20) + (0.1 * ARCMIN_TO_RAD);
  }

  /** Update tape speed. */
  setSpeed(tapeSpeedIps: number): void {
    this.tapeSpeedMps = tapeSpeedIps * 0.0254;
  }

  /** Update track spacing (e.g., when switching machine presets). */
  setTrackSpacing(meters: number): void {
    this.trackSpacing = meters;
  }

  /** Process a single sample through the azimuth delay line. */
  process(input: number): number {
    // Write input to circular buffer
    this.buffer[this.writeIdx] = input;

    // Compute instantaneous azimuth angle: static + drift modulation.
    // Two-component drift: slow reel effects (70%) + faster roller effects (30%)
    const drift = this.driftDepth * (
      0.7 * Math.sin(this.driftPhase1) +
      0.3 * Math.sin(this.driftPhase2)
    );
    const theta = this.staticAzimuth + drift;

    // Inter-channel delay: Δt = channelIndex * trackSpacing * tan(θ) / v
    // Channel 0 gets baseDelay only (reference latency).
    // Channel N gets baseDelay + N * azimuth offset.
    // All channels share the same baseDelay so the only inter-channel
    // difference is the physical azimuth-induced time shift.
    const delaySec = this.channelIndex * this.trackSpacing * Math.tan(theta) / this.tapeSpeedMps;
    const delaySamples = this.baseDelay + delaySec * this.sampleRate;

    // Advance drift LFOs
    this.advanceDrift();

    // Read from buffer with cubic Lagrange interpolation
    const readPos = this.writeIdx - delaySamples;
    const readFloor = Math.floor(readPos);
    const frac = readPos - readFloor;

    const s0 = this.readBuffer(readFloor - 1);
    const s1 = this.readBuffer(readFloor);
    const s2 = this.readBuffer(readFloor + 1);
    const s3 = this.readBuffer(readFloor + 2);

    // Cubic Lagrange interpolation (same formula as transport model)
    const output =
      s1 +
      0.5 *
        frac *
        (s2 - s0 +
          frac *
            (2 * s0 - 5 * s1 + 4 * s2 - s3 +
              frac * (3 * (s1 - s2) + s3 - s0)));

    // Advance write index
    this.writeIdx = (this.writeIdx + 1) % this.bufferSize;

    return output;
  }

  /** Advance drift LFO phases. */
  private advanceDrift(): void {
    this.driftPhase1 += this.driftRate1;
    if (this.driftPhase1 >= TWO_PI) this.driftPhase1 -= TWO_PI;
    this.driftPhase2 += this.driftRate2;
    if (this.driftPhase2 >= TWO_PI) this.driftPhase2 -= TWO_PI;
  }

  /** Read from the circular buffer with safe index wrapping. */
  private readBuffer(idx: number): number {
    return this.buffer[((idx % this.bufferSize) + this.bufferSize) % this.bufferSize];
  }

  /** Reset buffer and LFO state. */
  reset(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.driftPhase1 = 0;
    this.driftPhase2 = 0;
  }
}
