import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import {
  db,
  goertzelMagnitude,
  harmonicProfile,
  matchRmsGain,
  residualRms,
  rms,
} from './helpers/metrics';
import {
  createProcessor,
  renderMono,
  send,
  type TestProcessor,
  type WorkletParamValues,
} from './helpers/worklet-test-utils';
import { generateSine, generateTwoTone, generateWindowedSineBurst } from './helpers/signals';

const FS = 48_000;
const HOUSE_HEADROOM_DBFS = 18;
const SINE_RMS_TO_PEAK_DB = 20 * Math.log10(Math.SQRT2);
const ALIGNMENT_WINDOW = { warmup: 4_096, analysis: 12_000 };
const BASELINE_URL = new URL('./fixtures/tape-processor-characteristics.json', import.meta.url);
const UPDATE_BASELINE = process.env.UPDATE_TAPE_BASELINE === '1';

type PresetName = 'studer' | 'ampex' | 'mci';

interface CalibrationSnapshot {
  gainDb: number;
  thdDb: number;
  rmsDb: number;
  residualDb: number;
}

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
  };
}

function roundMetric(value: number): number {
  return +value.toFixed(6);
}

function rmsDbfsToSinePeak(dbfs: number): number {
  return Math.pow(10, (dbfs + SINE_RMS_TO_PEAK_DB) / 20);
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
  if (path.endsWith('thdDb')) return 0.6;
  if (path.endsWith('rmsDb')) return 0.25;
  if (path.endsWith('residualDb')) return 0.75;
  if (path.toLowerCase().endsWith('gaindb')) return 0.25;
  if (path.endsWith('deltaDb')) return 0.25;
  if (path.endsWith('lowImdDb') || path.endsWith('highImdDb')) return 0.6;
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
  }, 20_000);
});
