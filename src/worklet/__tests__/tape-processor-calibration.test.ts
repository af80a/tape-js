import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import {
  db,
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
import { generateSine } from './helpers/signals';

const FS = 48_000;
const HOUSE_HEADROOM_DBFS = 18;
const SINE_RMS_TO_PEAK_DB = 20 * Math.log10(Math.SQRT2);
const ALIGNMENT_WINDOW = { warmup: 4_096, analysis: 12_000 };

interface CalibrationSnapshot {
  gainDb: number;
  thdDb: number;
  rmsDb: number;
  residualDb: number;
}

type PresetName = 'studer' | 'ampex' | 'mci';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TapeProcessor house calibration', () => {
  it('keeps 1 kHz nominal alignment mostly linear across presets', async () => {
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
      expect(snapshot.residualDb).toBeLessThan(-28);
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
    expect(hotStats.residualDb).toBeGreaterThan(nominalStats.residualDb + 8);
  });

  it('keeps 30 ips nominal alignment mostly linear for the mastering decks', async () => {
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
      expect(snapshot.residualDb).toBeLessThan(-28);
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
});
