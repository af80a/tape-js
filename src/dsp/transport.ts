/**
 * Transport model — variable delay line driven by a physically structured
 * speed-error model.
 *
 * Instead of a single wow sine and flutter sine, the modulation is split into
 * named mechanical contributors:
 * 1. Supply/takeup reel eccentricity (slow wow components)
 * 2. Tension/servo wander (stochastic low-rate wow)
 * 3. Capstan rotation ripple (primary flutter component)
 * 4. Pinch/guide roller vibration (secondary flutter lines)
 * 5. Surface roughness / scrape flutter (band-limited stochastic flutter)
 *
 * The model generates instantaneous fractional speed error and integrates it
 * into a variable delay. A gentle servo restoring term keeps the cumulative
 * delay centered while preserving the expected wow/flutter amplitude.
 */

const TWO_PI = 2 * Math.PI;

// Maximum peak speed deviation at depth=1.0 (fraction, not percent).
// These remain the user-facing calibration anchors; the more detailed
// transport profile only redistributes that deviation across components.
const WOW_MAX_DEVIATION = 0.005;
const FLUTTER_MAX_DEVIATION = 0.002;

// Minimum configurable rates (Hz) — used for buffer sizing.
const MIN_WOW_RATE_HZ = 0.5;
const MIN_FLUTTER_RATE_HZ = 3;

// Delay-restoring servo. Small enough to preserve wow amplitude, but it keeps
// stochastic speed-error integration from walking the delay to infinity.
const SERVO_RESTORE_HZ = 0.03;

const WOW_PHASE_OFFSETS = [0, Math.PI * 0.37];
const WOW_SECONDARY_PHASE_OFFSETS = [Math.PI * 0.41, Math.PI * 0.89];
const FLUTTER_PHASE_OFFSETS = [Math.PI * 0.19, Math.PI * 0.83];
const FLUTTER_GUIDE_PHASE_OFFSETS = [Math.PI * 0.53, Math.PI * 1.11];

export interface TransportProfile {
  wowSupplyWeight: number;
  wowTakeupWeight: number;
  wowTensionWeight: number;
  wowSupplyRatio: number;
  wowTakeupRatio: number;
  wowTensionHz: number;
  reelDriftHz: number;
  reelDriftDepth: number;
  flutterCapstanWeight: number;
  flutterPinchWeight: number;
  flutterGuideWeight: number;
  flutterRoughnessWeight: number;
  flutterScrapeWeight: number;
  flutterPinchRatio: number;
  flutterGuideRatio: number;
  flutterRoughnessRatio: number;
  scrapeCenterHz: number;
  scrapeBandwidthHz: number;
}

export const DEFAULT_TRANSPORT_PROFILE: TransportProfile = {
  wowSupplyWeight: 0.52,
  wowTakeupWeight: 0.28,
  wowTensionWeight: 0.20,
  wowSupplyRatio: 0.82,
  wowTakeupRatio: 1.23,
  wowTensionHz: 0.7,
  reelDriftHz: 0.045,
  reelDriftDepth: 0.18,
  flutterCapstanWeight: 0.56,
  flutterPinchWeight: 0.18,
  flutterGuideWeight: 0.14,
  flutterRoughnessWeight: 0.08,
  flutterScrapeWeight: 0.04,
  flutterPinchRatio: 1.95,
  flutterGuideRatio: 1.35,
  flutterRoughnessRatio: 2.4,
  scrapeCenterHz: 900,
  scrapeBandwidthHz: 650,
};

function onePoleCoeff(hz: number, sampleRate: number): number {
  return 1 - Math.exp(-TWO_PI * Math.max(0.001, hz) / sampleRate);
}

function wrapPhase(phase: number): number {
  if (phase >= TWO_PI) return phase - TWO_PI;
  if (phase < 0) return phase + TWO_PI;
  return phase;
}

function estimateMaxDelaySamples(profile: TransportProfile, sampleRate: number): number {
  const wowOmega = TWO_PI * MIN_WOW_RATE_HZ / sampleRate;
  const supplyOmega = wowOmega * Math.max(0.25, profile.wowSupplyRatio * (1 - profile.reelDriftDepth));
  const takeupOmega = wowOmega * Math.max(0.25, profile.wowTakeupRatio * (1 - profile.reelDriftDepth * 0.5));
  const tensionOmega = TWO_PI * Math.max(0.2, profile.wowTensionHz) / sampleRate;

  const flutterOmega = TWO_PI * MIN_FLUTTER_RATE_HZ / sampleRate;
  const pinchOmega = flutterOmega * Math.max(0.5, profile.flutterPinchRatio);
  const guideOmega = flutterOmega * Math.max(0.5, profile.flutterGuideRatio);
  const roughOmega = flutterOmega * Math.max(0.5, profile.flutterRoughnessRatio);
  const scrapeOmega = TWO_PI * Math.max(80, profile.scrapeCenterHz - profile.scrapeBandwidthHz * 0.5) / sampleRate;

  const wowDelay =
    WOW_MAX_DEVIATION * (
      profile.wowSupplyWeight / supplyOmega +
      profile.wowTakeupWeight / takeupOmega +
      profile.wowTensionWeight / tensionOmega
    );

  const flutterDelay =
    FLUTTER_MAX_DEVIATION * (
      profile.flutterCapstanWeight / flutterOmega +
      profile.flutterPinchWeight / pinchOmega +
      profile.flutterGuideWeight / guideOmega +
      profile.flutterRoughnessWeight / roughOmega +
      profile.flutterScrapeWeight / scrapeOmega
    );

  return Math.max(8, Math.ceil(wowDelay + flutterDelay));
}

export class TransportModel {
  private readonly baseDelay: number;
  private readonly bufferSize: number;
  private readonly buffer: Float32Array;
  private readonly sampleRate: number;
  private readonly profile: TransportProfile;

  private wowRateHz: number;
  private flutterRateHz: number;
  private wowRate: number;
  private flutterRate: number;
  private wowDepth = 0;
  private flutterDepth = 0;
  private writeIdx = 0;
  private delayOffset = 0;

  private readonly initialSupplyPhase: number;
  private readonly initialTakeupPhase: number;
  private readonly initialCapstanPhase: number;
  private readonly initialGuidePhase: number;

  private supplyPhase: number;
  private takeupPhase: number;
  private capstanPhase: number;
  private pinchPhase: number;
  private guidePhase: number;
  private reelGeometryPhase = 0;

  private prngState: number;
  private tensionNoiseState = 0;
  private roughFastState = 0;
  private roughSlowState = 0;
  private scrapeFastState = 0;
  private scrapeSlowState = 0;

  private tensionNoiseCoeff: number;
  private roughFastCoeff: number;
  private roughSlowCoeff: number;
  private scrapeFastCoeff: number;
  private scrapeSlowCoeff: number;

  private readonly reelDriftRate: number;
  private readonly delayRestore: number;

  /**
   * @param sampleRate    Audio sample rate in Hz
   * @param channelIndex  Channel index for stereo phase detuning (default 0)
   * @param profile       Machine-specific transport profile
   */
  constructor(sampleRate: number, channelIndex = 0, profile: TransportProfile = DEFAULT_TRANSPORT_PROFILE) {
    this.sampleRate = sampleRate;
    this.profile = profile;

    const maxModulation = Math.ceil(estimateMaxDelaySamples(profile, sampleRate) * 1.2);
    this.baseDelay = maxModulation;
    this.bufferSize = 2 * maxModulation + 4;
    this.buffer = new Float32Array(this.bufferSize);

    this.wowRateHz = 1.2;
    this.flutterRateHz = 6.5;
    this.wowRate = TWO_PI * this.wowRateHz / sampleRate;
    this.flutterRate = TWO_PI * this.flutterRateHz / sampleRate;

    this.initialSupplyPhase = WOW_PHASE_OFFSETS[channelIndex] ?? 0;
    this.initialTakeupPhase = WOW_SECONDARY_PHASE_OFFSETS[channelIndex] ?? 0;
    this.initialCapstanPhase = FLUTTER_PHASE_OFFSETS[channelIndex] ?? 0;
    this.initialGuidePhase = FLUTTER_GUIDE_PHASE_OFFSETS[channelIndex] ?? 0;
    this.supplyPhase = this.initialSupplyPhase;
    this.takeupPhase = this.initialTakeupPhase;
    this.capstanPhase = this.initialCapstanPhase;
    this.pinchPhase = this.initialCapstanPhase + Math.PI * 0.27;
    this.guidePhase = this.initialGuidePhase;

    this.reelDriftRate = TWO_PI * profile.reelDriftHz / sampleRate;
    this.delayRestore = Math.exp(-TWO_PI * SERVO_RESTORE_HZ / sampleRate);

    this.tensionNoiseCoeff = onePoleCoeff(profile.wowTensionHz, sampleRate);
    this.roughFastCoeff = 0;
    this.roughSlowCoeff = 0;
    this.scrapeFastCoeff = onePoleCoeff(profile.scrapeCenterHz + profile.scrapeBandwidthHz * 0.5, sampleRate);
    this.scrapeSlowCoeff = onePoleCoeff(Math.max(1, profile.scrapeCenterHz - profile.scrapeBandwidthHz * 0.5), sampleRate);
    this.updateFlutterNoiseCoefficients();

    // Seed xorshift32 PRNG per channel for stereo decorrelation.
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

  /** Set wow base rate in Hz. */
  setWowRate(hz: number): void {
    this.wowRateHz = Math.max(MIN_WOW_RATE_HZ, hz);
    this.wowRate = TWO_PI * this.wowRateHz / this.sampleRate;
  }

  /** Set flutter base rate in Hz. */
  setFlutterRate(hz: number): void {
    this.flutterRateHz = Math.max(MIN_FLUTTER_RATE_HZ, hz);
    this.flutterRate = TWO_PI * this.flutterRateHz / this.sampleRate;
    this.updateFlutterNoiseCoefficients();
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

  private updateFlutterNoiseCoefficients(): void {
    const roughCenterHz = Math.max(4, this.flutterRateHz * this.profile.flutterRoughnessRatio);
    this.roughFastCoeff = onePoleCoeff(roughCenterHz * 1.9, this.sampleRate);
    this.roughSlowCoeff = onePoleCoeff(Math.max(1, roughCenterHz * 0.55), this.sampleRate);
  }

  /** Process a single sample through the variable delay line. */
  process(input: number): number {
    this.buffer[this.writeIdx] = input;

    const reelGeometry = Math.sin(this.reelGeometryPhase);
    const supplyRate =
      this.wowRate *
      Math.max(0.25, this.profile.wowSupplyRatio * (1 - this.profile.reelDriftDepth * reelGeometry));
    const takeupRate =
      this.wowRate *
      Math.max(0.25, this.profile.wowTakeupRatio * (1 + this.profile.reelDriftDepth * reelGeometry));
    const pinchRate = this.flutterRate * this.profile.flutterPinchRatio;
    const guideRate = this.flutterRate * this.profile.flutterGuideRatio;

    this.tensionNoiseState += this.tensionNoiseCoeff * (this.nextNoise() - this.tensionNoiseState);
    const roughInput = this.nextNoise();
    this.roughFastState += this.roughFastCoeff * (roughInput - this.roughFastState);
    this.roughSlowState += this.roughSlowCoeff * (roughInput - this.roughSlowState);
    const roughness = this.roughFastState - this.roughSlowState;

    const scrapeInput = this.nextNoise();
    this.scrapeFastState += this.scrapeFastCoeff * (scrapeInput - this.scrapeFastState);
    this.scrapeSlowState += this.scrapeSlowCoeff * (scrapeInput - this.scrapeSlowState);
    const scrape = this.scrapeFastState - this.scrapeSlowState;

    const wowDeviation = WOW_MAX_DEVIATION * this.wowDepth * (
      this.profile.wowSupplyWeight * Math.sin(this.supplyPhase) +
      this.profile.wowTakeupWeight * Math.sin(this.takeupPhase) +
      this.profile.wowTensionWeight * this.tensionNoiseState
    );
    const flutterDeviation = FLUTTER_MAX_DEVIATION * this.flutterDepth * (
      this.profile.flutterCapstanWeight * Math.sin(this.capstanPhase) +
      this.profile.flutterPinchWeight * Math.sin(this.pinchPhase) +
      this.profile.flutterGuideWeight * Math.sin(this.guidePhase) +
      this.profile.flutterRoughnessWeight * roughness * 1.6 +
      this.profile.flutterScrapeWeight * scrape * 2.2
    );

    this.delayOffset = this.delayOffset * this.delayRestore + wowDeviation + flutterDeviation;
    const safeDelay = Math.max(1, Math.min(this.bufferSize - 3, this.baseDelay + this.delayOffset));

    this.supplyPhase = wrapPhase(this.supplyPhase + supplyRate);
    this.takeupPhase = wrapPhase(this.takeupPhase + takeupRate);
    this.capstanPhase = wrapPhase(this.capstanPhase + this.flutterRate);
    this.pinchPhase = wrapPhase(this.pinchPhase + pinchRate);
    this.guidePhase = wrapPhase(this.guidePhase + guideRate);
    this.reelGeometryPhase = wrapPhase(this.reelGeometryPhase + this.reelDriftRate);

    const readPos = this.writeIdx - safeDelay;
    const readFloor = Math.floor(readPos);
    const frac = readPos - readFloor;

    const s0 = this.readBuffer(readFloor - 1);
    const s1 = this.readBuffer(readFloor);
    const s2 = this.readBuffer(readFloor + 1);
    const s3 = this.readBuffer(readFloor + 2);

    const output =
      s1 +
      0.5 *
        frac *
        (s2 - s0 +
          frac *
            (2 * s0 - 5 * s1 + 4 * s2 - s3 +
              frac * (3 * (s1 - s2) + s3 - s0)));

    this.writeIdx = (this.writeIdx + 1) % this.bufferSize;

    return output;
  }

  private readBuffer(idx: number): number {
    return this.buffer[
      ((idx % this.bufferSize) + this.bufferSize) % this.bufferSize
    ];
  }

  /** Reset buffer, write index, phases, and stochastic states. */
  reset(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.delayOffset = 0;
    this.supplyPhase = this.initialSupplyPhase;
    this.takeupPhase = this.initialTakeupPhase;
    this.capstanPhase = this.initialCapstanPhase;
    this.pinchPhase = this.initialCapstanPhase + Math.PI * 0.27;
    this.guidePhase = this.initialGuidePhase;
    this.reelGeometryPhase = 0;
    this.tensionNoiseState = 0;
    this.roughFastState = 0;
    this.roughSlowState = 0;
    this.scrapeFastState = 0;
    this.scrapeSlowState = 0;
  }
}
