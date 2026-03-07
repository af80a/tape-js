import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import {
  db,
  goertzelAnalysis,
  harmonicProfile,
  intermodulationProfile,
  matchRmsGain,
  residualRms,
  rms,
} from './helpers/metrics';
import {
  createProcessor,
  renderMono,
  renderStereo,
  send,
  type TestProcessor,
  type WorkletParamValues,
} from './helpers/worklet-test-utils';
import { generateSine, generateTwoTone } from './helpers/signals';

const FS = 48_000;
const HOUSE_HEADROOM_DBFS = 18;
const SINE_RMS_TO_PEAK_DB = 20 * Math.log10(Math.SQRT2);
const ALIGNMENT_WINDOW = { warmup: 4_096, analysis: 12_000 };
const HEAD_ONLY_BYPASSES = [
  'inputXfmr',
  'recordAmp',
  'recordEQ',
  'bias',
  'hysteresis',
  'transport',
  'noise',
  'playbackEQ',
  'playbackAmp',
  'outputXfmr',
] as const;

interface CalibrationSnapshot {
  gainDb: number;
  thdDb: number;
  rmsDb: number;
  residualDb: number;
}

type PresetName = 'studer' | 'ampex' | 'mci';
type NonlinearStressMode = 'recordDominant' | 'playbackDominant';

const NONLINEAR_LEVELS = [
  { key: 'minus24Dbfs', dbfs: -24 },
  { key: 'minus18Dbfs', dbfs: -18 },
  { key: 'minus12Dbfs', dbfs: -12 },
] as const;
const THD_SWEEP_FREQUENCIES = [
  { key: 'hz100', frequency: 100 },
  { key: 'hz1000', frequency: 1_000 },
  { key: 'hz10000', frequency: 10_000 },
] as const;
const IMD_SWEEP_CARRIERS = [
  { key: 'hz100', carrierHz: 100, modHz: 20 },
  { key: 'hz1000', carrierHz: 1_000, modHz: 60 },
  { key: 'hz10000', carrierHz: 10_000, modHz: 60 },
] as const;
const IMD_MOD_TO_CARRIER_RATIO = 1.5;

function rmsDbfsToSinePeak(dbfs: number): number {
  return Math.pow(10, (dbfs + SINE_RMS_TO_PEAK_DB) / 20);
}

function dbfsToLinear(dbfs: number): number {
  return Math.pow(10, dbfs / 20);
}

function wrapPhase(angle: number): number {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  while (wrapped < -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

function normalizedSinc(x: number): number {
  if (Math.abs(x) < 1e-12) return 1;
  const pix = Math.PI * x;
  return Math.abs(Math.sin(pix) / pix);
}

function presetParams(presetName: PresetName): Partial<WorkletParamValues> {
  const preset = PRESETS[presetName];
  return {
    bias: preset.biasDefault,
    drive: preset.drive,
    saturation: preset.saturation,
    ampDrive: preset.recordAmpDrive,
    outputGain: 1,
    wow: 0,
    flutter: 0,
    hiss: 0,
    color: 0,
    headroom: HOUSE_HEADROOM_DBFS,
  };
}

async function createCalibratedProcessor(preset: PresetName, tapeSpeed: 30 | 15 | 7.5 | 3.75 = 15): Promise<TestProcessor> {
  const processor = await createProcessor({
    preset,
    oversample: 4,
    tapeSpeed,
    recordCouplingMode: 'delayed',
  }, FS);

  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });

  return processor;
}

async function createHeadOnlyProcessor(
  preset: PresetName,
  tapeSpeed: 30 | 15 | 7.5 | 3.75 = 15,
): Promise<TestProcessor> {
  const processor = await createCalibratedProcessor(preset, tapeSpeed);
  for (const stageId of HEAD_ONLY_BYPASSES) {
    send(processor, { type: 'set-stage-bypass', stageId, value: true });
  }
  return processor;
}

function applyNonlinearStressMode(processor: TestProcessor, mode: NonlinearStressMode): void {
  if (mode === 'recordDominant') {
    send(processor, { type: 'set-stage-param', stageId: 'recordAmp', param: 'drive', value: 0.85 });
    send(processor, { type: 'set-stage-param', stageId: 'hysteresis', param: 'drive', value: 0.85 });
    send(processor, { type: 'set-stage-param', stageId: 'hysteresis', param: 'saturation', value: 0.85 });
    send(processor, { type: 'set-stage-param', stageId: 'playbackAmp', param: 'drive', value: 0.18 });
    send(processor, { type: 'set-stage-param', stageId: 'outputXfmr', param: 'satAmount', value: 0.6 });
    return;
  }

  send(processor, { type: 'set-stage-param', stageId: 'recordAmp', param: 'drive', value: 0.18 });
  send(processor, { type: 'set-stage-param', stageId: 'hysteresis', param: 'drive', value: 0.3 });
  send(processor, { type: 'set-stage-param', stageId: 'hysteresis', param: 'saturation', value: 0.3 });
  send(processor, { type: 'set-stage-param', stageId: 'playbackAmp', param: 'drive', value: 0.9 });
  send(processor, { type: 'set-stage-param', stageId: 'outputXfmr', param: 'satAmount', value: 1.2 });
}

async function createNonlinearCalibrationProcessor(mode: NonlinearStressMode): Promise<TestProcessor> {
  const processor = await createCalibratedProcessor('ampex', 15);
  applyNonlinearStressMode(processor, mode);
  return processor;
}

function renderCalibrationTone(
  processor: TestProcessor,
  frequency: number,
  inputPeak: number,
  params: Partial<WorkletParamValues> = {},
): { input: Float32Array; output: Float32Array; windowStart: number; windowEnd: number } {
  const totalLength = ALIGNMENT_WINDOW.warmup + ALIGNMENT_WINDOW.analysis;
  const input = new Float32Array(totalLength);
  input.set(generateSine(ALIGNMENT_WINDOW.warmup, FS, frequency, inputPeak));
  input.set(
    generateSine(ALIGNMENT_WINDOW.analysis, FS, frequency, inputPeak, 0, ALIGNMENT_WINDOW.warmup),
    ALIGNMENT_WINDOW.warmup,
  );

  const output = renderMono(processor, input, {
    params: {
      ...params,
    },
  });

  return {
    input,
    output,
    windowStart: ALIGNMENT_WINDOW.warmup,
    windowEnd: totalLength,
  };
}

function renderCalibrationTwoTone(
  processor: TestProcessor,
  tones: Array<{ frequency: number; amplitude: number }>,
  params: Partial<WorkletParamValues> = {},
): { output: Float32Array; windowStart: number; windowEnd: number } {
  const totalLength = ALIGNMENT_WINDOW.warmup + ALIGNMENT_WINDOW.analysis;
  const input = new Float32Array(totalLength);
  input.set(generateTwoTone(ALIGNMENT_WINDOW.warmup, FS, tones));
  input.set(
    generateTwoTone(ALIGNMENT_WINDOW.analysis, FS, tones, ALIGNMENT_WINDOW.warmup),
    ALIGNMENT_WINDOW.warmup,
  );

  return {
    output: renderMono(processor, input, { params }),
    windowStart: ALIGNMENT_WINDOW.warmup,
    windowEnd: totalLength,
  };
}

function renderStereoCalibrationTone(
  processor: TestProcessor,
  frequency: number,
  leftPeak: number,
  rightPeak: number,
  params: Partial<WorkletParamValues> = {},
): {
  inputLeft: Float32Array;
  inputRight: Float32Array;
  outputLeft: Float32Array;
  outputRight: Float32Array;
  windowStart: number;
  windowEnd: number;
} {
  const totalLength = ALIGNMENT_WINDOW.warmup + ALIGNMENT_WINDOW.analysis;
  const inputLeft = new Float32Array(totalLength);
  const inputRight = new Float32Array(totalLength);
  inputLeft.set(generateSine(ALIGNMENT_WINDOW.warmup, FS, frequency, leftPeak));
  inputRight.set(generateSine(ALIGNMENT_WINDOW.warmup, FS, frequency, rightPeak));
  inputLeft.set(
    generateSine(ALIGNMENT_WINDOW.analysis, FS, frequency, leftPeak, 0, ALIGNMENT_WINDOW.warmup),
    ALIGNMENT_WINDOW.warmup,
  );
  inputRight.set(
    generateSine(ALIGNMENT_WINDOW.analysis, FS, frequency, rightPeak, 0, ALIGNMENT_WINDOW.warmup),
    ALIGNMENT_WINDOW.warmup,
  );

  const [outputLeft, outputRight] = renderStereo(processor, inputLeft, inputRight, {
    params: {
      ...params,
    },
  });

  return {
    inputLeft,
    inputRight,
    outputLeft,
    outputRight,
    windowStart: ALIGNMENT_WINDOW.warmup,
    windowEnd: totalLength,
  };
}

function renderExtendedCalibrationTone(
  processor: TestProcessor,
  frequency: number,
  inputPeak: number,
  durationSeconds: number,
  params: Partial<WorkletParamValues> = {},
): { output: Float32Array; windowStart: number; windowEnd: number } {
  const warmup = ALIGNMENT_WINDOW.warmup;
  const analysis = Math.round(durationSeconds * FS);
  const totalLength = warmup + analysis;
  const input = new Float32Array(totalLength);
  input.set(generateSine(warmup, FS, frequency, inputPeak));
  input.set(
    generateSine(analysis, FS, frequency, inputPeak, 0, warmup),
    warmup,
  );

  return {
    output: renderMono(processor, input, { params }),
    windowStart: warmup,
    windowEnd: totalLength,
  };
}

function analyzeCalibrationTone(
  input: Float32Array,
  output: Float32Array,
  frequency: number,
  windowStart: number,
  windowEnd: number,
): CalibrationSnapshot {
  const inputProfile = harmonicProfile(input, FS, frequency, 5, windowStart, windowEnd);
  const outputProfile = harmonicProfile(output, FS, frequency, 5, windowStart, windowEnd);
  const gainDb = db(outputProfile.fundamental / Math.max(inputProfile.fundamental, 1e-12));
  const gainMatch = matchRmsGain(input, output, windowStart, windowEnd);

  return {
    gainDb,
    thdDb: db(outputProfile.thd),
    rmsDb: db(rms(output, windowStart, windowEnd)),
    residualDb: db(residualRms(input, output, gainMatch, windowStart, windowEnd)),
  };
}

function harmonicCountForFrequency(frequency: number): number {
  return Math.max(2, Math.min(5, Math.floor((FS / 2) / frequency)));
}

async function measureThdDb(
  mode: NonlinearStressMode,
  frequency: number,
  inputDbfs: number,
): Promise<number> {
  const processor = await createNonlinearCalibrationProcessor(mode);
  const render = renderCalibrationTone(
    processor,
    frequency,
    rmsDbfsToSinePeak(inputDbfs),
    presetParams('ampex'),
  );
  const profile = harmonicProfile(
    render.output,
    FS,
    frequency,
    harmonicCountForFrequency(frequency),
    render.windowStart,
    render.windowEnd,
  );
  return db(profile.thd);
}

async function measureImdDb(
  mode: NonlinearStressMode,
  carrierHz: number,
  modHz: number,
  inputDbfs: number,
): Promise<number> {
  const processor = await createNonlinearCalibrationProcessor(mode);
  const targetRms = dbfsToLinear(inputDbfs);
  const carrierAmp = targetRms / Math.sqrt((1 + IMD_MOD_TO_CARRIER_RATIO * IMD_MOD_TO_CARRIER_RATIO) / 2);
  const modAmp = carrierAmp * IMD_MOD_TO_CARRIER_RATIO;
  const render = renderCalibrationTwoTone(
    processor,
    [
      { frequency: modHz, amplitude: modAmp },
      { frequency: carrierHz, amplitude: carrierAmp },
    ],
    presetParams('ampex'),
  );
  const profile = intermodulationProfile(
    render.output,
    FS,
    carrierHz,
    modHz,
    render.windowStart,
    render.windowEnd,
  );
  return db(profile.imd);
}

async function measureWeaveModulationDepthDb(frequency: number, weaveArcmin: number): Promise<number> {
  const processor = await createHeadOnlyProcessor('ampex', 15);
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: weaveArcmin });
  const render = renderExtendedCalibrationTone(processor, frequency, 0.35, 4.0, {
    wow: 0,
    flutter: 0,
    hiss: 0,
    outputGain: 1,
  });

  const windowSize = 4_096;
  let minMag = Infinity;
  let maxMag = 0;
  for (let start = render.windowStart; start + windowSize <= render.windowEnd; start += windowSize) {
    const mag = goertzelAnalysis(render.output, FS, frequency, start, start + windowSize).magnitude;
    minMag = Math.min(minMag, mag);
    maxMag = Math.max(maxMag, mag);
  }

  return db(maxMag / Math.max(minMag, 1e-12));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TapeProcessor house calibration', () => {
  it('keeps 1 kHz nominal alignment within the approved coloration envelope across presets', async () => {
    const nominalInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS);
    const report: Record<string, CalibrationSnapshot> = {};

    for (const preset of ['studer', 'ampex', 'mci'] as const) {
      const processor = await createCalibratedProcessor(preset);
      const { input, output, windowStart, windowEnd } = renderCalibrationTone(
        processor,
        1_000,
        nominalInput,
        presetParams(preset),
      );
      report[preset] = analyzeCalibrationTone(input, output, 1_000, windowStart, windowEnd);
    }

    for (const snapshot of Object.values(report)) {
      expect(snapshot.gainDb).toBeGreaterThan(-0.5);
      expect(snapshot.gainDb).toBeLessThan(0.5);
      expect(snapshot.thdDb).toBeLessThan(-12);
      expect(snapshot.residualDb).toBeLessThan(-12);
    }
  });

  it('shows overload growth at +6 VU relative to nominal', async () => {
    const nominalInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS);
    const hotInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS + 6);
    const nominalProcessor = await createCalibratedProcessor('ampex');
    const hotProcessor = await createCalibratedProcessor('ampex');

    const nominal = renderCalibrationTone(nominalProcessor, 1_000, nominalInput, presetParams('ampex'));
    const hot = renderCalibrationTone(hotProcessor, 1_000, hotInput, presetParams('ampex'));

    const nominalStats = analyzeCalibrationTone(
      nominal.input,
      nominal.output,
      1_000,
      nominal.windowStart,
      nominal.windowEnd,
    );
    const hotStats = analyzeCalibrationTone(
      hot.input,
      hot.output,
      1_000,
      hot.windowStart,
      hot.windowEnd,
    );

    expect(hotStats.gainDb).toBeLessThan(nominalStats.gainDb - 3);
    expect(hotStats.thdDb).toBeGreaterThan(nominalStats.thdDb + 5);
    expect(hotStats.residualDb).toBeGreaterThan(nominalStats.residualDb + 5);
  });

  it('keeps 30 ips nominal alignment within the approved coloration envelope for the mastering decks', async () => {
    const nominalInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS);
    const report: Record<string, CalibrationSnapshot> = {};

    for (const preset of ['studer', 'ampex'] as const) {
      const processor = await createCalibratedProcessor(preset, 30);
      const { input, output, windowStart, windowEnd } = renderCalibrationTone(
        processor,
        1_000,
        nominalInput,
        presetParams(preset),
      );
      report[preset] = analyzeCalibrationTone(input, output, 1_000, windowStart, windowEnd);
    }

    for (const snapshot of Object.values(report)) {
      expect(snapshot.gainDb).toBeGreaterThan(-0.5);
      expect(snapshot.gainDb).toBeLessThan(0.5);
      expect(snapshot.thdDb).toBeLessThan(-12);
      expect(snapshot.residualDb).toBeLessThan(-12);
    }
  });

  it('30 ips carries more nominal high-frequency level than 15 ips', async () => {
    const nominalInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS);
    const fifteenProcessor = await createCalibratedProcessor('ampex', 15);
    const thirtyProcessor = await createCalibratedProcessor('ampex', 30);

    const at15 = renderCalibrationTone(fifteenProcessor, 16_000, nominalInput, presetParams('ampex'));
    const at30 = renderCalibrationTone(thirtyProcessor, 16_000, nominalInput, presetParams('ampex'));

    const stats15 = analyzeCalibrationTone(
      at15.input,
      at15.output,
      16_000,
      at15.windowStart,
      at15.windowEnd,
    );
    const stats30 = analyzeCalibrationTone(
      at30.input,
      at30.output,
      16_000,
      at30.windowStart,
      at30.windowEnd,
    );

    expect(stats30.gainDb).toBeGreaterThan(stats15.gainDb + 0.75);
  });

  it('head-only crosstalk through the full processor keeps the expected bathtub curve', async () => {
    async function measureBleedDb(frequency: number): Promise<number> {
      const processor = await createHeadOnlyProcessor('ampex', 15);
      send(processor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0.006 });
      const render = renderStereoCalibrationTone(processor, frequency, 0.5, 0, {
        wow: 0,
        flutter: 0,
        hiss: 0,
        outputGain: 1,
      });
      const source = goertzelAnalysis(render.outputLeft, FS, frequency, render.windowStart, render.windowEnd).magnitude;
      const bleed = goertzelAnalysis(render.outputRight, FS, frequency, render.windowStart, render.windowEnd).magnitude;
      return db(bleed / Math.max(source, 1e-12));
    }

    const lowDb = await measureBleedDb(100);
    const lowerMidDb = await measureBleedDb(1_000);
    const upperMidDb = await measureBleedDb(3_000);
    const highDb = await measureBleedDb(10_000);
    const bestMidDb = Math.min(lowerMidDb, upperMidDb);

    expect(lowerMidDb).toBeGreaterThan(-48);
    expect(lowerMidDb).toBeLessThan(-42);
    expect(bestMidDb).toBeLessThan(lowDb - 3);
    expect(bestMidDb).toBeLessThan(highDb - 1);
    expect(lowDb).toBeGreaterThan(lowerMidDb + 2);
  });

  it('head-only azimuth phase shift through the full processor follows the delay law', async () => {
    const azimuthArcmin = 3;
    const preset = PRESETS.ampex;
    const expectedDelaySec =
      preset.trackSpacing * Math.tan((Math.PI * azimuthArcmin) / (180 * 60)) / (15 * 0.0254);

    for (const frequency of [500, 2_000, 8_000]) {
      const processor = await createHeadOnlyProcessor('ampex', 15);
      send(processor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: azimuthArcmin });

      const render = renderStereoCalibrationTone(processor, frequency, 0.4, 0.4, {
        wow: 0,
        flutter: 0,
        hiss: 0,
        outputGain: 1,
      });
      const left = goertzelAnalysis(render.outputLeft, FS, frequency, render.windowStart, render.windowEnd);
      const right = goertzelAnalysis(render.outputRight, FS, frequency, render.windowStart, render.windowEnd);
      const measuredPhase = wrapPhase(right.phase - left.phase);
      const expectedPhase = wrapPhase(-2 * Math.PI * frequency * expectedDelaySec);
      const error = wrapPhase(measuredPhase - expectedPhase);

      expect(Math.abs(error)).toBeLessThan(0.12);
    }
  });

  it('head-only azimuth loss through the full processor tracks the theoretical sinc response', async () => {
    const azimuthArcmin = 30;
    const angleRad = (Math.PI * azimuthArcmin) / (180 * 60);

    for (const frequency of [1_000, 8_000, 16_000]) {
      const cleanProcessor = await createHeadOnlyProcessor('ampex', 15);
      const tiltedProcessor = await createHeadOnlyProcessor('ampex', 15);
      send(tiltedProcessor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: azimuthArcmin });

      const clean = renderStereoCalibrationTone(cleanProcessor, frequency, 0.35, 0, {
        wow: 0,
        flutter: 0,
        hiss: 0,
        outputGain: 1,
      });
      const tilted = renderStereoCalibrationTone(tiltedProcessor, frequency, 0.35, 0, {
        wow: 0,
        flutter: 0,
        hiss: 0,
        outputGain: 1,
      });

      const cleanMag = goertzelAnalysis(clean.outputLeft, FS, frequency, clean.windowStart, clean.windowEnd).magnitude;
      const tiltedMag = goertzelAnalysis(tilted.outputLeft, FS, frequency, tilted.windowStart, tilted.windowEnd).magnitude;
      const measuredGain = tiltedMag / Math.max(cleanMag, 1e-12);
      const theoreticalGain = normalizedSinc(
        PRESETS.ampex.trackWidth * frequency * Math.tan(angleRad) / (15 * 0.0254),
      );

      expect(Math.abs(db(measuredGain) - db(theoreticalGain))).toBeLessThan(1.0);
    }
  });

  it('record- and playback-stressed THD varies materially with level across low, mid, and high frequencies', async () => {
    for (const mode of ['recordDominant', 'playbackDominant'] as const) {
      for (const { frequency } of THD_SWEEP_FREQUENCIES) {
        const lowThdDb = await measureThdDb(mode, frequency, -24);
        const nominalThdDb = await measureThdDb(mode, frequency, -18);
        const hotThdDb = await measureThdDb(mode, frequency, -12);
        const cleanestThdDb = Math.min(lowThdDb, nominalThdDb, hotThdDb);
        const dirtiestThdDb = Math.max(lowThdDb, nominalThdDb, hotThdDb);

        expect(Number.isFinite(lowThdDb)).toBe(true);
        expect(Number.isFinite(nominalThdDb)).toBe(true);
        expect(Number.isFinite(hotThdDb)).toBe(true);
        expect(dirtiestThdDb - cleanestThdDb).toBeGreaterThan(1);
      }
    }
  }, 20_000);

  it('record- and playback-stressed IMD varies materially with level across low, mid, and high carriers', async () => {
    for (const mode of ['recordDominant', 'playbackDominant'] as const) {
      for (const { carrierHz, modHz } of IMD_SWEEP_CARRIERS) {
        const lowImdDb = await measureImdDb(mode, carrierHz, modHz, -24);
        const nominalImdDb = await measureImdDb(mode, carrierHz, modHz, -18);
        const hotImdDb = await measureImdDb(mode, carrierHz, modHz, -12);
        const cleanestImdDb = Math.min(lowImdDb, nominalImdDb, hotImdDb);
        const dirtiestImdDb = Math.max(lowImdDb, nominalImdDb, hotImdDb);

        expect(Number.isFinite(lowImdDb)).toBe(true);
        expect(Number.isFinite(nominalImdDb)).toBe(true);
        expect(Number.isFinite(hotImdDb)).toBe(true);
        expect(dirtiestImdDb - cleanestImdDb).toBeGreaterThan(1);
      }
    }
  }, 20_000);

  it('head-only weave modulates high frequencies more than midband through the full processor', async () => {
    const midDepthDb = await measureWeaveModulationDepthDb(1_000, 5);
    const highDepthDb = await measureWeaveModulationDepthDb(16_000, 5);

    expect(highDepthDb).toBeGreaterThan(0.1);
    expect(highDepthDb).toBeGreaterThan(midDepthDb + 0.1);
    expect(midDepthDb).toBeLessThan(0.4);
  }, 15_000);
});
