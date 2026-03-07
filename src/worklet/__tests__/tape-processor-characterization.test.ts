import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../dsp/presets';
import {
  dcOffset,
  db,
  goertzelMagnitude,
  harmonicProfile,
  peakAbs,
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
const TAPE_ONLY_BYPASSES = [
  'inputXfmr',
  'recordAmp',
  'head',
  'transport',
  'noise',
  'playbackAmp',
  'outputXfmr',
] as const;

interface CouplingSnapshot {
  maxDelayedIg: number;
  maxDelayedTapeSat: number;
  maxDelayedPbIg: number;
  maxDelayedOxfmrSat: number;
}

function createCouplingSnapshot(): CouplingSnapshot {
  return {
    maxDelayedIg: 0,
    maxDelayedTapeSat: 0,
    maxDelayedPbIg: 0,
    maxDelayedOxfmrSat: 0,
  };
}

function collectCouplingSnapshot(processor: TestProcessor, snapshot: CouplingSnapshot): void {
  const delayedIg = processor['delayedIg'] as number[];
  const delayedTapeSat = processor['delayedTapeSat'] as number[];
  const delayedPbIg = processor['delayedPbIg'] as number[];
  const delayedOxfmrSat = processor['delayedOxfmrSat'] as number[];

  snapshot.maxDelayedIg = Math.max(snapshot.maxDelayedIg, Math.abs(delayedIg[0] ?? 0));
  snapshot.maxDelayedTapeSat = Math.max(snapshot.maxDelayedTapeSat, delayedTapeSat[0] ?? 0);
  snapshot.maxDelayedPbIg = Math.max(snapshot.maxDelayedPbIg, Math.abs(delayedPbIg[0] ?? 0));
  snapshot.maxDelayedOxfmrSat = Math.max(snapshot.maxDelayedOxfmrSat, delayedOxfmrSat[0] ?? 0);
}

async function createAnalysisProcessor(): Promise<TestProcessor> {
  return createAnalysisProcessorWithMode('delayed');
}

async function createAnalysisProcessorWithMode(mode: 'delayed' | 'predictor'): Promise<TestProcessor> {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TapeProcessor characterization harness', () => {
  it('bias misalignment stays subtle around the calibrated point while preserving the expected tradeoff', async () => {
    const nominalProcessor = await createAnalysisProcessor();
    const underbiasProcessor = await createAnalysisProcessor();
    const overbiasProcessor = await createAnalysisProcessor();
    const highNominalProcessor = await createAnalysisProcessor();
    const highUnderbiasProcessor = await createAnalysisProcessor();
    const highOverbiasProcessor = await createAnalysisProcessor();
    const warmupLength = 4_096;
    const analysisLength = 12_000;
    const totalLength = warmupLength + analysisLength;
    const nominalBias = PRESETS.ampex.biasDefault;

    for (const processor of [nominalProcessor, underbiasProcessor, overbiasProcessor, highNominalProcessor, highUnderbiasProcessor, highOverbiasProcessor]) {
      for (const stageId of TAPE_ONLY_BYPASSES) {
        send(processor, { type: 'set-stage-bypass', stageId, value: true });
      }
    }

    const oneKilohertz = new Float32Array(totalLength);
    oneKilohertz.set(generateSine(warmupLength, FS, 1_000, 0.25));
    oneKilohertz.set(generateSine(analysisLength, FS, 1_000, 0.25, 0, warmupLength), warmupLength);

    const tenKilohertz = new Float32Array(totalLength);
    tenKilohertz.set(generateSine(warmupLength, FS, 10_000, 0.12));
    tenKilohertz.set(generateSine(analysisLength, FS, 10_000, 0.12, 0, warmupLength), warmupLength);

    const nominalParams: Partial<WorkletParamValues> = {
      inputGain: 1,
      bias: nominalBias,
      drive: 0.35,
      saturation: 0.4,
      ampDrive: 0.22,
      wow: 0,
      flutter: 0,
      hiss: 0,
      color: 0,
      headroom: 18,
      outputGain: 1,
    };
    const underbiasParams: Partial<WorkletParamValues> = {
      ...nominalParams,
      bias: 0.35,
    };
    const overbiasParams: Partial<WorkletParamValues> = {
      ...nominalParams,
      bias: 1.0,
    };

    const nominalMid = renderMono(nominalProcessor, oneKilohertz, { params: nominalParams });
    const underbiasMid = renderMono(underbiasProcessor, oneKilohertz, { params: underbiasParams });
    const overbiasMid = renderMono(overbiasProcessor, oneKilohertz, { params: overbiasParams });
    const nominalHigh = renderMono(highNominalProcessor, tenKilohertz, { params: nominalParams });
    const underbiasHigh = renderMono(highUnderbiasProcessor, tenKilohertz, { params: underbiasParams });
    const overbiasHigh = renderMono(highOverbiasProcessor, tenKilohertz, { params: overbiasParams });

    const windowStart = warmupLength;
    const windowEnd = totalLength;
    const nominalMidProfile = harmonicProfile(nominalMid, FS, 1_000, 5, windowStart, windowEnd);
    const underbiasMidProfile = harmonicProfile(underbiasMid, FS, 1_000, 5, windowStart, windowEnd);
    const overbiasMidProfile = harmonicProfile(overbiasMid, FS, 1_000, 5, windowStart, windowEnd);
    const nominalHighProfile = harmonicProfile(nominalHigh, FS, 10_000, 1, windowStart, windowEnd);
    const underbiasHighProfile = harmonicProfile(underbiasHigh, FS, 10_000, 1, windowStart, windowEnd);
    const overbiasHighProfile = harmonicProfile(overbiasHigh, FS, 10_000, 1, windowStart, windowEnd);

    const highLossDb = db(overbiasHighProfile.fundamental / Math.max(nominalHighProfile.fundamental, 1e-12));
    const midLossDb = db(overbiasMidProfile.fundamental / Math.max(nominalMidProfile.fundamental, 1e-12));

    expect(underbiasMidProfile.thd).toBeGreaterThan(nominalMidProfile.thd);
    expect(highLossDb).toBeLessThan(-0.2);
    expect(highLossDb).toBeGreaterThan(-3);
    expect(highLossDb).toBeLessThan(midLossDb - 0.2);
    expect(underbiasHighProfile.fundamental).toBeGreaterThan(overbiasHighProfile.fundamental);
  });

  it('stronger drive produces stronger coupling response and longer transient recovery', async () => {
    const lowProcessor = await createAnalysisProcessor();
    const highProcessor = await createAnalysisProcessor();

    const totalLength = 16_384;
    const burstStart = 2_048;
    const burstLength = 4_800;
    const burst = generateWindowedSineBurst(totalLength, FS, {
      start: burstStart,
      length: burstLength,
      frequency: 95,
      amplitude: 0.8,
    });

    const lowSnapshot = createCouplingSnapshot();
    const highSnapshot = createCouplingSnapshot();

    const lowOutput = renderMono(lowProcessor, burst, {
      params: drivePreset('low'),
      probe: (processor) => collectCouplingSnapshot(processor, lowSnapshot),
    });
    const highOutput = renderMono(highProcessor, burst, {
      params: drivePreset('high'),
      probe: (processor) => collectCouplingSnapshot(processor, highSnapshot),
    });

    const recoveryStart = burstStart + burstLength;
    const earlyRecoveryEnd = recoveryStart + 2_048;
    const lateTailStart = totalLength - 2_048;

    const lowEarlyRecovery = rms(lowOutput, recoveryStart, earlyRecoveryEnd);
    const highEarlyRecovery = rms(highOutput, recoveryStart, earlyRecoveryEnd);
    const lowLateTail = rms(lowOutput, lateTailStart, totalLength);
    const highLateTail = rms(highOutput, lateTailStart, totalLength);

    expect(peakAbs(lowOutput)).toBeLessThanOrEqual(2.01);
    expect(peakAbs(highOutput)).toBeLessThanOrEqual(2.01);
    expect(Math.abs(dcOffset(lowOutput))).toBeLessThan(0.05);
    expect(Math.abs(dcOffset(highOutput))).toBeLessThan(0.05);

    expect(highSnapshot.maxDelayedIg).toBeGreaterThan(lowSnapshot.maxDelayedIg * 1.5);
    expect(highSnapshot.maxDelayedTapeSat).toBeGreaterThan(lowSnapshot.maxDelayedTapeSat * 1.25);
    expect(highSnapshot.maxDelayedPbIg).toBeGreaterThan(lowSnapshot.maxDelayedPbIg * 1.25);
    expect(highSnapshot.maxDelayedOxfmrSat).toBeGreaterThan(lowSnapshot.maxDelayedOxfmrSat * 1.1);

    expect(lowEarlyRecovery).toBeGreaterThan(lowLateTail * 2);
    expect(highEarlyRecovery).toBeGreaterThan(highLateTail * 3);
  });

  it('stronger drive increases two-tone IMD sidebands in the steady-state output', async () => {
    const lowProcessor = await createAnalysisProcessor();
    const highProcessor = await createAnalysisProcessor();

    const warmupLength = 4_096;
    const analysisLength = 12_000;
    const lowInput = new Float32Array(warmupLength + analysisLength);
    lowInput.set(generateTwoTone(warmupLength, FS, [
      { frequency: 60, amplitude: 0.18 },
      { frequency: 7_000, amplitude: 0.12 },
    ]));
    lowInput.set(generateTwoTone(analysisLength, FS, [
      { frequency: 60, amplitude: 0.18 },
      { frequency: 7_000, amplitude: 0.12 },
    ], warmupLength), warmupLength);

    const highInput = lowInput;

    const lowOutput = renderMono(lowProcessor, lowInput, {
      params: drivePreset('low'),
    });
    const highOutput = renderMono(highProcessor, highInput, {
      params: drivePreset('high'),
    });

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

    const lowImdDb = db(lowSidebands / Math.max(lowFundamental, 1e-12));
    const highImdDb = db(highSidebands / Math.max(highFundamental, 1e-12));

    const matchedHighGain = rms(lowOutput, windowStart, windowEnd) / Math.max(rms(highOutput, windowStart, windowEnd), 1e-12);
    const nullResidualDb = db(residualRms(lowOutput, highOutput, matchedHighGain, windowStart, windowEnd));

    expect(Math.abs(dcOffset(lowOutput, windowStart, windowEnd))).toBeLessThan(0.05);
    expect(Math.abs(dcOffset(highOutput, windowStart, windowEnd))).toBeLessThan(0.05);

    expect(highFundamental).toBeGreaterThan(0);
    expect(lowFundamental).toBeGreaterThan(0);
    expect(highImdDb).toBeGreaterThan(lowImdDb + 3);
    expect(nullResidualDb).toBeGreaterThan(-45);
  });

  it('predictor coupling measurably changes high-drive transient recovery', async () => {
    const delayedProcessor = await createAnalysisProcessorWithMode('delayed');
    const predictorProcessor = await createAnalysisProcessorWithMode('predictor');

    const totalLength = 16_384;
    const burstStart = 2_048;
    const burstLength = 4_800;
    const burst = generateWindowedSineBurst(totalLength, FS, {
      start: burstStart,
      length: burstLength,
      frequency: 95,
      amplitude: 0.8,
    });

    const delayedOutput = renderMono(delayedProcessor, burst, {
      params: drivePreset('high'),
    });
    const predictorOutput = renderMono(predictorProcessor, burst, {
      params: drivePreset('high'),
    });

    const attackStart = burstStart;
    const analysisEnd = totalLength;
    const recoveryStart = burstStart + burstLength;
    const recoveryEnd = recoveryStart + 2_048;
    const delayedRecovery = rms(delayedOutput, recoveryStart, recoveryEnd);
    const predictorRecovery = rms(predictorOutput, recoveryStart, recoveryEnd);
    const recoveryRatio = predictorRecovery / Math.max(delayedRecovery, 1e-12);
    const matchedPredictorGain = rms(delayedOutput, attackStart, analysisEnd) / Math.max(rms(predictorOutput, attackStart, analysisEnd), 1e-12);
    const transientResidualDb = db(residualRms(delayedOutput, predictorOutput, matchedPredictorGain, attackStart, analysisEnd));

    expect(peakAbs(delayedOutput)).toBeLessThanOrEqual(2.01);
    expect(peakAbs(predictorOutput)).toBeLessThanOrEqual(2.01);
    expect(Math.abs(dcOffset(delayedOutput))).toBeLessThan(0.05);
    expect(Math.abs(dcOffset(predictorOutput))).toBeLessThan(0.05);

    expect(Math.abs(recoveryRatio - 1)).toBeGreaterThan(0.02);
    expect(transientResidualDb).toBeGreaterThan(-45);
  });

  it('predictor coupling measurably changes high-drive two-tone response without instability', async () => {
    const delayedProcessor = await createAnalysisProcessorWithMode('delayed');
    const predictorProcessor = await createAnalysisProcessorWithMode('predictor');

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

    const delayedOutput = renderMono(delayedProcessor, input, {
      params: drivePreset('high'),
    });
    const predictorOutput = renderMono(predictorProcessor, input, {
      params: drivePreset('high'),
    });

    const windowStart = warmupLength;
    const windowEnd = warmupLength + analysisLength;
    const delayedFundamental = goertzelMagnitude(delayedOutput, FS, 7_000, windowStart, windowEnd);
    const predictorFundamental = goertzelMagnitude(predictorOutput, FS, 7_000, windowStart, windowEnd);
    const delayedImdDb = db(
      (
        goertzelMagnitude(delayedOutput, FS, 6_940, windowStart, windowEnd) +
        goertzelMagnitude(delayedOutput, FS, 7_060, windowStart, windowEnd)
      ) / Math.max(delayedFundamental, 1e-12),
    );
    const predictorImdDb = db(
      (
        goertzelMagnitude(predictorOutput, FS, 6_940, windowStart, windowEnd) +
        goertzelMagnitude(predictorOutput, FS, 7_060, windowStart, windowEnd)
      ) / Math.max(predictorFundamental, 1e-12),
    );
    const matchedPredictorGain = rms(delayedOutput, windowStart, windowEnd) / Math.max(rms(predictorOutput, windowStart, windowEnd), 1e-12);
    const residualDb = db(residualRms(delayedOutput, predictorOutput, matchedPredictorGain, windowStart, windowEnd));

    expect(Math.abs(dcOffset(delayedOutput, windowStart, windowEnd))).toBeLessThan(0.05);
    expect(Math.abs(dcOffset(predictorOutput, windowStart, windowEnd))).toBeLessThan(0.05);
    expect(delayedFundamental).toBeGreaterThan(0);
    expect(predictorFundamental).toBeGreaterThan(0);
    expect(Math.abs(predictorImdDb - delayedImdDb)).toBeGreaterThan(2);
    expect(Math.abs(predictorImdDb - delayedImdDb)).toBeLessThan(12);
    expect(residualDb).toBeGreaterThan(-45);
  });

  it('higher coupling amount stays roughly level-matched while preserving measurable predictor-mode interaction', async () => {
    const lowCouplingProcessor = await createProcessor({
      preset: 'ampex',
      oversample: 4,
      tapeSpeed: 15,
      recordCouplingMode: 'predictor',
      couplingAmount: 0.75,
    }, FS);
    const highCouplingProcessor = await createProcessor({
      preset: 'ampex',
      oversample: 4,
      tapeSpeed: 15,
      recordCouplingMode: 'predictor',
      couplingAmount: 1.5,
    }, FS);

    send(lowCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 0 });
    send(lowCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
    send(lowCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
    send(lowCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });
    send(highCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 0 });
    send(highCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
    send(highCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
    send(highCouplingProcessor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });

    const burstLength = 16_384;
    const burstStart = 2_048;
    const burstWindow = 4_800;
    const burstInput = generateWindowedSineBurst(burstLength, FS, {
      start: burstStart,
      length: burstWindow,
      frequency: 95,
      amplitude: 0.8,
    });

    const lowBurst = renderMono(lowCouplingProcessor, burstInput, {
      params: drivePreset('high'),
    });
    const highBurst = renderMono(highCouplingProcessor, burstInput, {
      params: drivePreset('high'),
    });

    const burstRecoveryStart = burstStart + burstWindow;
    const burstRecoveryEnd = burstRecoveryStart + 2_048;
    const matchedBurstGain = rms(lowBurst, burstStart, burstLength) / Math.max(rms(highBurst, burstStart, burstLength), 1e-12);
    const burstResidualDb = db(residualRms(lowBurst, highBurst, matchedBurstGain, burstStart, burstLength));

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

    const lowOutput = renderMono(lowCouplingProcessor, input, {
      params: drivePreset('high'),
    });
    const highOutput = renderMono(highCouplingProcessor, input, {
      params: drivePreset('high'),
    });

    const windowStart = warmupLength;
    const windowEnd = warmupLength + analysisLength;
    const lowFundamental = goertzelMagnitude(lowOutput, FS, 7_000, windowStart, windowEnd);
    const highFundamental = goertzelMagnitude(highOutput, FS, 7_000, windowStart, windowEnd);
    const lowOutputRms = rms(lowOutput, windowStart, windowEnd);
    const highOutputRms = rms(highOutput, windowStart, windowEnd);
    const matchedHighGain = lowOutputRms / Math.max(highOutputRms, 1e-12);
    const levelRatio = highOutputRms / Math.max(lowOutputRms, 1e-12);
    const residualDb = db(residualRms(lowOutput, highOutput, matchedHighGain, windowStart, windowEnd));

    expect(peakAbs(lowBurst)).toBeLessThanOrEqual(2.01);
    expect(peakAbs(highBurst)).toBeLessThanOrEqual(2.01);
    expect(Math.abs(dcOffset(lowBurst))).toBeLessThan(0.05);
    expect(Math.abs(dcOffset(highBurst))).toBeLessThan(0.05);
    expect(rms(highBurst, burstRecoveryStart, burstRecoveryEnd)).toBeGreaterThan(rms(lowBurst, burstRecoveryStart, burstRecoveryEnd) * 1.25);
    expect(burstResidualDb).toBeGreaterThan(-40);

    expect(Math.abs(dcOffset(lowOutput, windowStart, windowEnd))).toBeLessThan(0.05);
    expect(Math.abs(dcOffset(highOutput, windowStart, windowEnd))).toBeLessThan(0.05);
    expect(lowFundamental).toBeGreaterThan(0);
    expect(highFundamental).toBeGreaterThan(0);
    expect(levelRatio).toBeGreaterThan(0.95);
    expect(levelRatio).toBeLessThan(1.05);
    expect(residualDb).toBeGreaterThan(-40);
  });

  it('head dropouts attenuate hiss because tape noise now lives on the tape path', async () => {
    const cleanProcessor = await createProcessor({
      preset: 'ampex',
      oversample: 1,
      tapeSpeed: 15,
    }, FS);
    const dirtyProcessor = await createProcessor({
      preset: 'ampex',
      oversample: 1,
      tapeSpeed: 15,
    }, FS);

    send(cleanProcessor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
    send(cleanProcessor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
    send(cleanProcessor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });
    send(cleanProcessor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 0 });

    send(dirtyProcessor, { type: 'set-stage-param', stageId: 'head', param: 'azimuth', value: 0 });
    send(dirtyProcessor, { type: 'set-stage-param', stageId: 'head', param: 'weave', value: 0 });
    send(dirtyProcessor, { type: 'set-stage-param', stageId: 'head', param: 'crosstalk', value: 0 });
    send(dirtyProcessor, { type: 'set-stage-param', stageId: 'head', param: 'dropouts', value: 1 });

    const silence = new Float32Array(600_000);
    const noiseOnly: Partial<WorkletParamValues> = {
      inputGain: 1,
      bias: 0.5,
      drive: 0.2,
      saturation: 0.2,
      ampDrive: 0.2,
      wow: 0,
      flutter: 0,
      hiss: 1,
      color: 0,
      headroom: 24,
      outputGain: 1,
    };

    const cleanOutput = renderMono(cleanProcessor, silence, { params: noiseOnly });
    const dirtyOutput = renderMono(dirtyProcessor, silence, { params: noiseOnly });

    expect(peakAbs(cleanOutput)).toBeGreaterThan(1e-4);
    expect(peakAbs(dirtyOutput)).toBeGreaterThan(1e-4);
    expect(residualRms(cleanOutput, dirtyOutput)).toBeGreaterThan(1e-5);
  });
});
