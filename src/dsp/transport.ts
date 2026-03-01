/**
 * Transport model — variable delay line with cubic Lagrange
 * interpolation for wow and flutter simulation.
 *
 * Wow is a slow (~1.2 Hz) pitch modulation caused by mechanical
 * irregularities in the tape transport. Flutter is a faster
 * (~6.5 Hz) modulation from capstan and guide roller vibrations.
 */

const TWO_PI = 2 * Math.PI;

export class TransportModel {
  private readonly maxDelaySamples: number;
  private readonly baseDelay: number;
  private readonly bufferSize: number;
  private readonly buffer: Float32Array;

  private readonly wowRate: number;
  private readonly flutterRate: number;

  private wowPhase = 0;
  private flutterPhase = 0;
  private wowDepth = 0;
  private flutterDepth = 0;
  private writeIdx = 0;

  /** @param sampleRate  Audio sample rate in Hz */
  constructor(sampleRate: number) {
    this.maxDelaySamples = Math.ceil(sampleRate * 0.05); // 50 ms
    this.baseDelay = this.maxDelaySamples / 2;
    this.bufferSize = this.maxDelaySamples + 4; // extra for interpolation
    this.buffer = new Float32Array(this.bufferSize);

    this.wowRate = TWO_PI * 1.2 / sampleRate;
    this.flutterRate = TWO_PI * 6.5 / sampleRate;
  }

  /** Set wow depth (clamped to 0-1). */
  setWow(v: number): void {
    this.wowDepth = Math.max(0, Math.min(1, v));
  }

  /** Set flutter depth (clamped to 0-1). */
  setFlutter(v: number): void {
    this.flutterDepth = Math.max(0, Math.min(1, v));
  }

  /** Process a single sample through the variable delay line. */
  process(input: number): number {
    // 1. Write input to circular buffer
    this.buffer[this.writeIdx] = input;

    // 2. Calculate modulated delay
    const wowMod =
      Math.sin(this.wowPhase) * this.wowDepth * this.maxDelaySamples * 0.3;
    const flutterMod =
      Math.sin(this.flutterPhase) *
      this.flutterDepth *
      this.maxDelaySamples *
      0.05;
    const delay = this.baseDelay + wowMod + flutterMod;

    // 3. Advance LFO phases (wrap at 2pi)
    this.wowPhase += this.wowRate;
    if (this.wowPhase >= TWO_PI) this.wowPhase -= TWO_PI;
    this.flutterPhase += this.flutterRate;
    if (this.flutterPhase >= TWO_PI) this.flutterPhase -= TWO_PI;

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

  /** Reset buffer, write index, and LFO phases. */
  reset(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.wowPhase = 0;
    this.flutterPhase = 0;
  }
}
