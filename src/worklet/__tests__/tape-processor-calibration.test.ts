import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import { db, goertzelAnalysis } from './helpers/metrics';
import {
  createProcessor,
  renderMono,
  renderStereo,
  send,
  type TestProcessor,
  type WorkletParamValues,
} from './helpers/worklet-test-utils';
import { generateSine } from './helpers/signals';

/**
 * Evidence notes:
 * - This integration suite only keeps published-standard or geometry-backed checks.
 * - It avoids house alignment targets, private solver state, and sound baselines.
 * - EQ, azimuth delay, azimuth sinc loss, and crosstalk shape remain because they
 *   can be tied back to explicit equations or documented machine behavior.
 */

const FS = 48_000;
const REFERENCE_HEADROOM_DB = 18;
const REFERENCE_INPUT_PEAK = 0.1;
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

type PresetName = 'studer' | 'ampex' | 'mci';

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
    bias: preset.defaults.bias,
    drive: preset.defaults.hysteresisDrive,
    saturation: preset.defaults.hysteresisSaturation,
    ampDrive: preset.defaults.recordAmpDrive,
    outputGain: 1,
    wow: 0,
    flutter: 0,
    hiss: 0,
    color: 0,
    headroom: REFERENCE_HEADROOM_DB,
  };
}

async function createPhysicsProcessor(
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
  const processor = await createPhysicsProcessor(preset, tapeSpeed);
  for (const stageId of HEAD_ONLY_BYPASSES) {
    send(processor, { type: 'set-stage-bypass', stageId, value: true });
  }
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

  return {
    input,
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

  const [outputLeft, outputRight] = renderStereo(processor, inputLeft, inputRight, { params });

  return {
    inputLeft,
    inputRight,
    outputLeft,
    outputRight,
    windowStart: ALIGNMENT_WINDOW.warmup,
    windowEnd: totalLength,
  };
}

function measureFundamentalGainDb(
  input: Float32Array,
  output: Float32Array,
  frequency: number,
  windowStart: number,
  windowEnd: number,
): number {
  const inputMag = goertzelAnalysis(input, FS, frequency, windowStart, windowEnd).magnitude;
  const outputMag = goertzelAnalysis(output, FS, frequency, windowStart, windowEnd).magnitude;
  return db(outputMag / Math.max(inputMag, 1e-12));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TapeProcessor physical constraints', () => {
  it('30 ips carries more 16 kHz playback level than 15 ips through the processor', async () => {
    const fifteenProcessor = await createPhysicsProcessor('ampex', 15);
    const thirtyProcessor = await createPhysicsProcessor('ampex', 30);

    const at15 = renderCalibrationTone(
      fifteenProcessor,
      16_000,
      REFERENCE_INPUT_PEAK,
      presetParams('ampex'),
    );
    const at30 = renderCalibrationTone(
      thirtyProcessor,
      16_000,
      REFERENCE_INPUT_PEAK,
      presetParams('ampex'),
    );

    const gain15Db = measureFundamentalGainDb(
      at15.input,
      at15.output,
      16_000,
      at15.windowStart,
      at15.windowEnd,
    );
    const gain30Db = measureFundamentalGainDb(
      at30.input,
      at30.output,
      16_000,
      at30.windowStart,
      at30.windowEnd,
    );

    expect(gain30Db).toBeGreaterThan(gain15Db + 0.75);
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

    expect(lowerMidDb).toBeGreaterThan(-55);
    expect(lowerMidDb).toBeLessThan(-35);
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
});
