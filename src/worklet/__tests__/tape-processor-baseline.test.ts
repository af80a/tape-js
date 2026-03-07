import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import {
  db,
  goertzelAnalysis,
  goertzelMagnitude,
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
import { generateSine, generateTwoTone, generateWindowedSineBurst } from './helpers/signals';

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
const BASELINE_URL = new URL('./fixtures/tape-processor-characteristics.json', import.meta.url);
const UPDATE_BASELINE = process.env.UPDATE_TAPE_BASELINE === '1';

type PresetName = 'studer' | 'ampex' | 'mci';
type NonlinearStressMode = 'recordDominant' | 'playbackDominant';

interface CalibrationSnapshot {
  gainDb: number;
  thdDb: number;
  rmsDb: number;
  residualDb: number;
}

interface ThdLevelSweep {
  minus24DbfsThdDb: number;
  minus18DbfsThdDb: number;
  minus12DbfsThdDb: number;
}

interface ImdLevelSweep {
  minus24DbfsImdDb: number;
  minus18DbfsImdDb: number;
  minus12DbfsImdDb: number;
}

interface NonlinearThdSweep {
  hz100: ThdLevelSweep;
  hz1000: ThdLevelSweep;
  hz10000: ThdLevelSweep;
}

interface NonlinearImdSweep {
  hz100: ImdLevelSweep;
  hz1000: ImdLevelSweep;
  hz10000: ImdLevelSweep;
}

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

interface BaselineReport {
  version: 1;
  generatedAt: string;
  sampleRate: number;
  scenarios: {
    alignment1k: Record<PresetName, CalibrationSnapshot>;
    overload1kAmpex: {
      nominal: CalibrationSnapshot;
      hot: CalibrationSnapshot;
    };
    highFrequency16kAmpex: {
      ips15GainDb: number;
      ips30GainDb: number;
      deltaDb: number;
    };
    twoToneImdAmpex: {
      lowImdDb: number;
      highImdDb: number;
      nullResidualDb: number;
    };
    predictorBurstAmpex: {
      recoveryRatio: number;
      transientResidualDb: number;
    };
    headCrosstalkCurveAmpex: {
      bleed100HzDb: number;
      bleed1000HzDb: number;
      bleed3000HzDb: number;
      bleed10000HzDb: number;
    };
    headAzimuthPhaseAmpex: {
      phase500Rad: number;
      phase2000Rad: number;
      phase8000Rad: number;
    };
    headAzimuthLossAmpex: {
      loss1000Db: number;
      loss8000Db: number;
      loss16000Db: number;
    };
    headWeaveModulationAmpex: {
      depth1000HzDb: number;
      depth16000HzDb: number;
      deltaDb: number;
    };
    thdLevelSweepAmpex: {
      recordDominant: NonlinearThdSweep;
      playbackDominant: NonlinearThdSweep;
    };
    imdLevelSweepAmpex: {
      recordDominant: NonlinearImdSweep;
      playbackDominant: NonlinearImdSweep;
    };
  };
}

function roundMetric(value: number): number {
  return +value.toFixed(6);
}

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

function roundCalibrationSnapshot(snapshot: CalibrationSnapshot): CalibrationSnapshot {
  return {
    gainDb: roundMetric(snapshot.gainDb),
    thdDb: roundMetric(snapshot.thdDb),
    rmsDb: roundMetric(snapshot.rmsDb),
    residualDb: roundMetric(snapshot.residualDb),
  };
}

async function createCalibratedProcessor(
  preset: PresetName,
  tapeSpeed: 30 | 15 | 7.5 | 3.75 = 15,
): Promise<TestProcessor> {
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

async function createAnalysisProcessor(mode: 'delayed' | 'predictor' = 'delayed'): Promise<TestProcessor> {
  const processor = await createProcessor({
    preset: 'ampex',
    oversample: 4,
    tapeSpeed: 15,
    recordCouplingMode: mode,
  }, FS);

  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
  send(processor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });

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

function drivePreset(mode: 'low' | 'high'): Partial<WorkletParamValues> {
  if (mode === 'low') {
    return {
      inputGain: 0.9,
      bias: 0.45,
      drive: 0.2,
      saturation: 0.25,
      ampDrive: 0.2,
      wow: 0,
      flutter: 0,
      hiss: 0,
      color: 0,
      headroom: 24,
      outputGain: 1,
    };
  }

  return {
    inputGain: 1.35,
    bias: 0.6,
    drive: 0.85,
    saturation: 0.85,
    ampDrive: 0.85,
    wow: 0,
    flutter: 0,
    hiss: 0,
    color: 0,
    headroom: 12,
    outputGain: 1,
  };
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

  const output = renderMono(processor, input, { params });
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

  const [outputLeft, outputRight] = renderStereo(processor, inputLeft, inputRight, { params });
  return {
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

function createEmptyThdLevelSweep(): ThdLevelSweep {
  return {
    minus24DbfsThdDb: 0,
    minus18DbfsThdDb: 0,
    minus12DbfsThdDb: 0,
  };
}

function createEmptyImdLevelSweep(): ImdLevelSweep {
  return {
    minus24DbfsImdDb: 0,
    minus18DbfsImdDb: 0,
    minus12DbfsImdDb: 0,
  };
}

function createEmptyNonlinearThdSweep(): NonlinearThdSweep {
  return {
    hz100: createEmptyThdLevelSweep(),
    hz1000: createEmptyThdLevelSweep(),
    hz10000: createEmptyThdLevelSweep(),
  };
}

function createEmptyNonlinearImdSweep(): NonlinearImdSweep {
  return {
    hz100: createEmptyImdLevelSweep(),
    hz1000: createEmptyImdLevelSweep(),
    hz10000: createEmptyImdLevelSweep(),
  };
}

function loadBaselineReport(): BaselineReport {
  try {
    return JSON.parse(readFileSync(BASELINE_URL, 'utf8')) as BaselineReport;
  } catch (error) {
    throw new Error(
      `Missing tape baseline at ${fileURLToPath(BASELINE_URL)}. Run UPDATE_TAPE_BASELINE=1 vitest on this file once to generate it.`,
      { cause: error },
    );
  }
}

function saveBaselineReport(report: BaselineReport): void {
  const baselinePath = fileURLToPath(BASELINE_URL);
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
}

function flattenNumericMetrics(
  value: Record<string, unknown>,
  prefix = '',
  metrics: Map<string, number> = new Map(),
): Map<string, number> {
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === 'number') {
      metrics.set(path, nested);
      continue;
    }
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      flattenNumericMetrics(nested as Record<string, unknown>, path, metrics);
    }
  }
  return metrics;
}

function toleranceForMetric(path: string): number {
  if (path.endsWith('recoveryRatio')) return 0.03;
  if (
    path.endsWith('bleed100HzDb')
    || path.endsWith('bleed1000HzDb')
    || path.endsWith('bleed3000HzDb')
    || path.endsWith('bleed10000HzDb')
  ) return 0.5;
  if (path.endsWith('depth1000HzDb') || path.endsWith('depth16000HzDb')) return 0.25;
  if (path.endsWith('phase500Rad') || path.endsWith('phase2000Rad') || path.endsWith('phase8000Rad')) return 0.12;
  if (path.toLowerCase().endsWith('thddb')) return 0.6;
  if (path.endsWith('rmsDb')) return 0.25;
  if (path.endsWith('residualDb')) return 0.75;
  if (path.endsWith('loss1000Db') || path.endsWith('loss8000Db') || path.endsWith('loss16000Db')) return 0.4;
  if (path.toLowerCase().endsWith('gaindb')) return 0.25;
  if (path.endsWith('deltaDb')) return 0.25;
  if (path.endsWith('ImdDb')) return 0.6;
  if (path.endsWith('nullResidualDb') || path.endsWith('transientResidualDb')) return 0.75;
  throw new Error(`Unhandled baseline metric tolerance for ${path}`);
}

function expectReportToMatchBaseline(actual: BaselineReport, baseline: BaselineReport): void {
  expect(actual.version).toBe(baseline.version);
  expect(actual.sampleRate).toBe(baseline.sampleRate);

  const actualMetrics = flattenNumericMetrics(actual.scenarios);
  const baselineMetrics = flattenNumericMetrics(baseline.scenarios);

  expect([...actualMetrics.keys()].sort()).toEqual([...baselineMetrics.keys()].sort());

  for (const [path, expectedValue] of baselineMetrics) {
    const actualValue = actualMetrics.get(path);
    expect(actualValue).not.toBeUndefined();
    expect(Math.abs((actualValue as number) - expectedValue)).toBeLessThanOrEqual(toleranceForMetric(path));
  }
}

async function buildBaselineReport(): Promise<BaselineReport> {
  const nominalInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS);
  const hotInput = rmsDbfsToSinePeak(-HOUSE_HEADROOM_DBFS + 6);

  const alignment1k: Record<PresetName, CalibrationSnapshot> = {
    studer: roundCalibrationSnapshot({ gainDb: 0, thdDb: 0, rmsDb: 0, residualDb: 0 }),
    ampex: roundCalibrationSnapshot({ gainDb: 0, thdDb: 0, rmsDb: 0, residualDb: 0 }),
    mci: roundCalibrationSnapshot({ gainDb: 0, thdDb: 0, rmsDb: 0, residualDb: 0 }),
  };

  for (const preset of ['studer', 'ampex', 'mci'] as const) {
    const processor = await createCalibratedProcessor(preset);
    const { input, output, windowStart, windowEnd } = renderCalibrationTone(
      processor,
      1_000,
      nominalInput,
      presetParams(preset),
    );
    alignment1k[preset] = roundCalibrationSnapshot(
      analyzeCalibrationTone(input, output, 1_000, windowStart, windowEnd),
    );
  }

  const nominalProcessor = await createCalibratedProcessor('ampex');
  const hotProcessor = await createCalibratedProcessor('ampex');
  const nominalTone = renderCalibrationTone(nominalProcessor, 1_000, nominalInput, presetParams('ampex'));
  const hotTone = renderCalibrationTone(hotProcessor, 1_000, hotInput, presetParams('ampex'));
  const overload1kAmpex = {
    nominal: roundCalibrationSnapshot(
      analyzeCalibrationTone(
        nominalTone.input,
        nominalTone.output,
        1_000,
        nominalTone.windowStart,
        nominalTone.windowEnd,
      ),
    ),
    hot: roundCalibrationSnapshot(
      analyzeCalibrationTone(
        hotTone.input,
        hotTone.output,
        1_000,
        hotTone.windowStart,
        hotTone.windowEnd,
      ),
    ),
  };

  const fifteenProcessor = await createCalibratedProcessor('ampex', 15);
  const thirtyProcessor = await createCalibratedProcessor('ampex', 30);
  const at15 = renderCalibrationTone(fifteenProcessor, 16_000, nominalInput, presetParams('ampex'));
  const at30 = renderCalibrationTone(thirtyProcessor, 16_000, nominalInput, presetParams('ampex'));
  const gain15 = analyzeCalibrationTone(at15.input, at15.output, 16_000, at15.windowStart, at15.windowEnd).gainDb;
  const gain30 = analyzeCalibrationTone(at30.input, at30.output, 16_000, at30.windowStart, at30.windowEnd).gainDb;
  const highFrequency16kAmpex = {
    ips15GainDb: roundMetric(gain15),
    ips30GainDb: roundMetric(gain30),
    deltaDb: roundMetric(gain30 - gain15),
  };

  const lowProcessor = await createAnalysisProcessor('delayed');
  const highProcessor = await createAnalysisProcessor('delayed');
  const warmupLength = 4_096;
  const analysisLength = 12_000;
  const input = new Float32Array(warmupLength + analysisLength);
  input.set(generateTwoTone(warmupLength, FS, [
    { frequency: 60, amplitude: 0.18 },
    { frequency: 7_000, amplitude: 0.12 },
  ]));
  input.set(generateTwoTone(analysisLength, FS, [
    { frequency: 60, amplitude: 0.18 },
    { frequency: 7_000, amplitude: 0.12 },
  ], warmupLength), warmupLength);

  const lowOutput = renderMono(lowProcessor, input, { params: drivePreset('low') });
  const highOutput = renderMono(highProcessor, input, { params: drivePreset('high') });
  const windowStart = warmupLength;
  const windowEnd = warmupLength + analysisLength;
  const lowFundamental = goertzelMagnitude(lowOutput, FS, 7_000, windowStart, windowEnd);
  const highFundamental = goertzelMagnitude(highOutput, FS, 7_000, windowStart, windowEnd);
  const lowSidebands =
    goertzelMagnitude(lowOutput, FS, 6_940, windowStart, windowEnd) +
    goertzelMagnitude(lowOutput, FS, 7_060, windowStart, windowEnd);
  const highSidebands =
    goertzelMagnitude(highOutput, FS, 6_940, windowStart, windowEnd) +
    goertzelMagnitude(highOutput, FS, 7_060, windowStart, windowEnd);
  const matchedHighGain = rms(lowOutput, windowStart, windowEnd) / Math.max(rms(highOutput, windowStart, windowEnd), 1e-12);
  const twoToneImdAmpex = {
    lowImdDb: roundMetric(db(lowSidebands / Math.max(lowFundamental, 1e-12))),
    highImdDb: roundMetric(db(highSidebands / Math.max(highFundamental, 1e-12))),
    nullResidualDb: roundMetric(db(residualRms(lowOutput, highOutput, matchedHighGain, windowStart, windowEnd))),
  };

  const delayedProcessor = await createAnalysisProcessor('delayed');
  const predictorProcessor = await createAnalysisProcessor('predictor');
  const burstLength = 16_384;
  const burstStart = 2_048;
  const burstWindow = 4_800;
  const burst = generateWindowedSineBurst(burstLength, FS, {
    start: burstStart,
    length: burstWindow,
    frequency: 95,
    amplitude: 0.8,
  });
  const delayedOutput = renderMono(delayedProcessor, burst, { params: drivePreset('high') });
  const predictorOutput = renderMono(predictorProcessor, burst, { params: drivePreset('high') });
  const recoveryStart = burstStart + burstWindow;
  const recoveryEnd = recoveryStart + 2_048;
  const delayedRecovery = rms(delayedOutput, recoveryStart, recoveryEnd);
  const predictorRecovery = rms(predictorOutput, recoveryStart, recoveryEnd);
  const matchedPredictorGain = rms(delayedOutput, burstStart, burstLength) / Math.max(rms(predictorOutput, burstStart, burstLength), 1e-12);
  const predictorBurstAmpex = {
    recoveryRatio: roundMetric(predictorRecovery / Math.max(delayedRecovery, 1e-12)),
    transientResidualDb: roundMetric(db(residualRms(
      delayedOutput,
      predictorOutput,
      matchedPredictorGain,
      burstStart,
      burstLength,
    ))),
  };

  async function measureHeadCrosstalkDb(frequency: number): Promise<number> {
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

  const headCrosstalkCurveAmpex = {
    bleed100HzDb: roundMetric(await measureHeadCrosstalkDb(100)),
    bleed1000HzDb: roundMetric(await measureHeadCrosstalkDb(1_000)),
    bleed3000HzDb: roundMetric(await measureHeadCrosstalkDb(3_000)),
    bleed10000HzDb: roundMetric(await measureHeadCrosstalkDb(10_000)),
  };

  const azimuthPhaseArcmin = 3;
  const headAzimuthPhaseAmpex = {
    phase500Rad: 0,
    phase2000Rad: 0,
    phase8000Rad: 0,
  };
  for (const [key, frequency] of [
    ['phase500Rad', 500],
    ['phase2000Rad', 2_000],
    ['phase8000Rad', 8_000],
  ] as const) {
    const processor = await createHeadOnlyProcessor('ampex', 15);
    send(processor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: azimuthPhaseArcmin });
    const render = renderStereoCalibrationTone(processor, frequency, 0.4, 0.4, {
      wow: 0,
      flutter: 0,
      hiss: 0,
      outputGain: 1,
    });
    const left = goertzelAnalysis(render.outputLeft, FS, frequency, render.windowStart, render.windowEnd);
    const right = goertzelAnalysis(render.outputRight, FS, frequency, render.windowStart, render.windowEnd);
    headAzimuthPhaseAmpex[key] = roundMetric(wrapPhase(right.phase - left.phase));
  }

  const azimuthLossArcmin = 30;
  const headAzimuthLossAmpex = {
    loss1000Db: 0,
    loss8000Db: 0,
    loss16000Db: 0,
  };
  for (const [key, frequency] of [
    ['loss1000Db', 1_000],
    ['loss8000Db', 8_000],
    ['loss16000Db', 16_000],
  ] as const) {
    const cleanProcessor = await createHeadOnlyProcessor('ampex', 15);
    const tiltedProcessor = await createHeadOnlyProcessor('ampex', 15);
    send(tiltedProcessor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: azimuthLossArcmin });
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
    headAzimuthLossAmpex[key] = roundMetric(db(tiltedMag / Math.max(cleanMag, 1e-12)));
  }

  const weaveMidDepthDb = await measureWeaveModulationDepthDb(1_000, 5);
  const weaveHighDepthDb = await measureWeaveModulationDepthDb(16_000, 5);
  const headWeaveModulationAmpex = {
    depth1000HzDb: roundMetric(weaveMidDepthDb),
    depth16000HzDb: roundMetric(weaveHighDepthDb),
    deltaDb: roundMetric(weaveHighDepthDb - weaveMidDepthDb),
  };

  const thdLevelSweepAmpex = {
    recordDominant: createEmptyNonlinearThdSweep(),
    playbackDominant: createEmptyNonlinearThdSweep(),
  };
  for (const mode of ['recordDominant', 'playbackDominant'] as const) {
    for (const { key, frequency } of THD_SWEEP_FREQUENCIES) {
      const levelSweep = createEmptyThdLevelSweep();
      for (const level of NONLINEAR_LEVELS) {
        const metricKey = `${level.key}ThdDb` as keyof ThdLevelSweep;
        levelSweep[metricKey] = roundMetric(await measureThdDb(mode, frequency, level.dbfs));
      }
      thdLevelSweepAmpex[mode][key] = levelSweep;
    }
  }

  const imdLevelSweepAmpex = {
    recordDominant: createEmptyNonlinearImdSweep(),
    playbackDominant: createEmptyNonlinearImdSweep(),
  };
  for (const mode of ['recordDominant', 'playbackDominant'] as const) {
    for (const { key, carrierHz, modHz } of IMD_SWEEP_CARRIERS) {
      const levelSweep = createEmptyImdLevelSweep();
      for (const level of NONLINEAR_LEVELS) {
        const metricKey = `${level.key}ImdDb` as keyof ImdLevelSweep;
        levelSweep[metricKey] = roundMetric(await measureImdDb(mode, carrierHz, modHz, level.dbfs));
      }
      imdLevelSweepAmpex[mode][key] = levelSweep;
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sampleRate: FS,
    scenarios: {
      alignment1k,
      overload1kAmpex,
      highFrequency16kAmpex,
      twoToneImdAmpex,
      predictorBurstAmpex,
      headCrosstalkCurveAmpex,
      headAzimuthPhaseAmpex,
      headAzimuthLossAmpex,
      headWeaveModulationAmpex,
      thdLevelSweepAmpex,
      imdLevelSweepAmpex,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TapeProcessor persisted characterization', () => {
  it('matches the stored sound baseline within tolerances', async () => {
    const report = await buildBaselineReport();

    if (UPDATE_BASELINE) {
      saveBaselineReport(report);
    }

    const baseline = UPDATE_BASELINE ? report : loadBaselineReport();
    expectReportToMatchBaseline(report, baseline);
  }, 60_000);
});
