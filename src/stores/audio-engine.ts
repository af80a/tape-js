import { create } from 'zustand';
import { AudioFileLoader } from '../audio/file-loader';
import { WorkletBridge, createWorkletBridge, getWorkletUrl } from '../audio/worklet-bridge';
import { STAGE_IDS, type StageId } from '../types/stages';
import type { WorkletMessage, WorkletResponse } from '../types/messages';
import { audioBufferToWav, buildProcessedFileName } from '../audio/wav-export';
import { PRESETS, type MachinePreset } from '../dsp/presets';
import { useStageParams } from './stage-params';

export interface StageMeterLevels {
  vuDb: number[];
  peakDb: number[];
  saturation?: number;
}

export interface ScopeSnapshot {
  vuDb: number;
  gainDelta: number;
  saturation: number;
}

export const SCOPE_STAGE_IDS = ['inputXfmr', 'recordAmp', 'hysteresis', 'playbackAmp', 'outputXfmr'] as const;
export type ScopeStageId = (typeof SCOPE_STAGE_IDS)[number];
type DebugStatsResponse = Extract<WorkletResponse, { type: 'debug-stats' }>;

export const SCOPE_BUFFER_SIZE = 100; // ~5 seconds at 50ms meter interval

const PARAM_KEYS = ['inputGain', 'bias', 'drive', 'saturation', 'ampDrive', 'wow', 'flutter', 'hiss', 'color', 'outputGain'] as const;
type ParamKey = (typeof PARAM_KEYS)[number];

function isParamKey(name: string): name is ParamKey {
  return (PARAM_KEYS as readonly string[]).includes(name);
}

function initStageMeterState(): Record<string, StageMeterLevels> {
  const meters: Record<string, StageMeterLevels> = {};
  for (const id of STAGE_IDS) {
    meters[id] = { vuDb: [-60, -60], peakDb: [-60, -60] };
  }
  return meters;
}

interface StageSnapshot {
  bypassed: boolean;
  variant?: string;
  params: Record<string, number>;
}

type StageSnapshotMap = Record<StageId, StageSnapshot>;
type ActiveStageParamMap = Record<StageId, Record<string, true>>;

interface WorkletSyncTarget {
  postMessage: (msg: WorkletMessage) => void;
  setParam: (name: string, value: number, time: number) => void;
}

function initActiveStageParams(): ActiveStageParamMap {
  const active = {} as ActiveStageParamMap;
  for (const id of STAGE_IDS) {
    active[id] = {};
  }
  return active;
}

function resolvePreset(presetName: string): MachinePreset {
  return PRESETS[presetName] ?? PRESETS['studer'];
}

function buildParamValuesFromPreset(preset: MachinePreset): Record<ParamKey, number> {
  return {
    inputGain: 1.0,
    bias: preset.biasDefault,
    drive: preset.drive,
    saturation: preset.saturation,
    ampDrive: preset.recordAmpDrive,
    wow: preset.wowDefault,
    flutter: preset.flutterDefault,
    hiss: preset.hissDefault,
    color: 0,
    outputGain: 1.0,
  };
}

function buildPresetStageParams(): ActiveStageParamMap {
  const active = initActiveStageParams();
  // Playback amp has its own preset drive and cannot be reconstructed
  // exactly from the single global `ampDrive` AudioParam.
  active.playbackAmp.drive = true;
  return active;
}

function formatMetricArray(values?: number[]): string {
  return values && values.length ? values.join('/') : 'n/a';
}

function logDebugStats(msg: DebugStatsResponse): void {
  console.log(
    `[tape] timer=${msg.timerSource} max=${msg.maxProcessMs}ms avg=${msg.avgProcessMs}ms (rec=${msg.avgRecordMs} pb=${msg.avgPlaybackMs}) budget=${msg.budgetMs}ms | overruns/s=${msg.overrunsPerSec} | nanAmp=${msg.nanAmpCount} | nanHyst=${msg.nanHystCount ?? 0} | rms=${formatMetricArray(msg.outRms)} peak=${formatMetricArray(msg.outPeak)} dc=${formatMetricArray(msg.outDc)} clamp=${formatMetricArray(msg.outClampHits)} nonfinOut=${formatMetricArray(msg.outNonFinite)} lrDb=${msg.lrImbalanceDb ?? 0}`
  );
}

interface AudioEngineState {
  audioCtx: AudioContext | null;
  bridge: WorkletBridge | null;
  loader: AudioFileLoader | null;
  isPlaying: boolean;
  globalBypassed: boolean;
  machinePreset: string;
  tapeSpeed: number;
  oversample: number;
  formula: string;
  headroom: number;
  currentTime: number;
  duration: number;
  vuDb: number[];
  peakDb: number[];
  stageMeters: Record<string, StageMeterLevels>;
  scopeBuffers: Record<ScopeStageId, ScopeSnapshot[]>;
  scopeBufferIndex: number;
  scopeOpen: boolean;
  offlineProcessing: boolean;
  offlineProgress: number;
  paramValues: Record<ParamKey, number>;
  activeStageParams: ActiveStageParamMap;

  // Actions
  toggleScope: () => void;
  ensureAudioContext: () => Promise<void>;
  loadFile: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setMachinePreset: (preset: string, stages?: StageSnapshotMap) => void;
  setTapeSpeed: (speed: number) => void;
  setOversample: (factor: number) => void;
  setFormula: (formula: string) => void;
  setHeadroom: (headroom: number) => void;
  setGlobalBypass: (bypassed: boolean) => void;
  setParam: (name: string, value: number) => void;
  postMessage: (msg: Parameters<WorkletBridge['postMessage']>[0]) => void;
  processOffline16x: () => Promise<void>;
  updateMeters: (vuDb: number[], peakDb: number[]) => void;
  updateStageMeters: (levels: Record<string, StageMeterLevels>) => void;
  updateTime: (current: number, duration: number) => void;
}

const DEFAULT_PRESET = resolvePreset('studer');

function applyStateToWorklet(
  target: WorkletSyncTarget,
  state: Pick<
    AudioEngineState,
    'machinePreset' | 'tapeSpeed' | 'formula' | 'globalBypassed' | 'headroom' | 'paramValues' | 'activeStageParams'
  >,
  stages: StageSnapshotMap,
  oversample: number,
  time = 0,
): void {
  target.postMessage({ type: 'set-preset', value: state.machinePreset });
  target.postMessage({ type: 'set-speed', value: state.tapeSpeed });
  target.postMessage({ type: 'set-oversample', value: oversample });
  target.postMessage({ type: 'set-formula', value: state.formula });
  target.postMessage({ type: 'set-bypass', value: state.globalBypassed });

  for (const key of PARAM_KEYS) {
    target.setParam(key, state.paramValues[key], time);
  }
  target.setParam('headroom', state.headroom, time);

  for (const stageId of STAGE_IDS) {
    const stage = stages[stageId];
    target.postMessage({ type: 'set-stage-bypass', stageId, value: stage.bypassed });
    if (stage.variant) {
      target.postMessage({ type: 'set-stage-variant', stageId, value: stage.variant });
    }
    for (const param of Object.keys(state.activeStageParams[stageId])) {
      const value = stage.params[param];
      if (typeof value !== 'number') continue;
      target.postMessage({ type: 'set-stage-param', stageId, param, value });
    }
  }
}

export const useAudioEngine = create<AudioEngineState>((set, get) => ({
  audioCtx: null,
  bridge: null,
  loader: null,
  isPlaying: false,
  globalBypassed: false,
  machinePreset: 'studer',
  tapeSpeed: 15,
  oversample: 2,
  formula: '900',
  headroom: 18,
  currentTime: 0,
  duration: 0,
  vuDb: [-20, -20],
  peakDb: [-20, -20],
  stageMeters: initStageMeterState(),
  scopeBuffers: Object.fromEntries(
    SCOPE_STAGE_IDS.map(id => [id, Array.from({ length: SCOPE_BUFFER_SIZE }, () => ({ vuDb: -60, gainDelta: 0, saturation: 0 }))])
  ) as Record<ScopeStageId, ScopeSnapshot[]>,
  scopeBufferIndex: 0,
  scopeOpen: false,
  offlineProcessing: false,
  offlineProgress: 0,
  paramValues: buildParamValuesFromPreset(DEFAULT_PRESET),
  activeStageParams: buildPresetStageParams(),

  toggleScope: () => set((s) => ({ scopeOpen: !s.scopeOpen })),

  ensureAudioContext: async () => {
    if (get().audioCtx) return;

    const audioCtx = new AudioContext();
    const bridge = await createWorkletBridge(audioCtx);
    const state = get();
    applyStateToWorklet(bridge, state, useStageParams.getState().stages, state.oversample);

    bridge.onMessage((msg) => {
      if (msg.type === 'meters') {
        get().updateMeters(msg.vuDb, msg.peakDb);
      } else if (msg.type === 'stage-meters') {
        get().updateStageMeters(msg.levels);
      } else if (msg.type === 'debug-stats') {
        logDebugStats(msg);
      }
    });

    const loader = new AudioFileLoader(audioCtx, bridge.node);
    loader.setTimeUpdateCallback((current, duration) => {
      get().updateTime(current, duration);
    });

    set({ audioCtx, bridge, loader });
  },

  loadFile: async (file: File) => {
    await get().ensureAudioContext();
    const loader = get().loader!;
    await loader.loadFile(file);
    loader.play();
    set({ isPlaying: true });
  },

  play: () => {
    get().loader?.play();
    set({ isPlaying: true });
  },

  pause: () => {
    get().loader?.pause();
    set({ isPlaying: false });
  },

  stop: () => {
    get().loader?.stop();
    set({ isPlaying: false, currentTime: 0 });
  },

  seek: (time: number) => {
    get().loader?.seek(time);
    set({ currentTime: time });
  },

  setMachinePreset: (preset: string, stages?: StageSnapshotMap) => {
    // When changing machines, reset the character controls to match the machine's defaults
    // so the user gets the true machine experience out of the box.
    const resolvedPreset = resolvePreset(preset);
    const resolvedPresetName = PRESETS[preset] ? preset : 'studer';
    const paramValues = buildParamValuesFromPreset(resolvedPreset);
    const activeStageParams = buildPresetStageParams();
    const nextState = get();
    const nextStages = stages ?? useStageParams.getState().stages;

    if (nextState.bridge) {
      applyStateToWorklet(
        nextState.bridge,
        {
          machinePreset: resolvedPresetName,
          tapeSpeed: nextState.tapeSpeed,
          formula: resolvedPreset.defaultFormula,
          globalBypassed: nextState.globalBypassed,
          headroom: nextState.headroom,
          paramValues,
          activeStageParams,
        },
        nextStages,
        nextState.oversample,
        nextState.audioCtx?.currentTime ?? 0,
      );
    }

    set({
      machinePreset: resolvedPresetName,
      formula: resolvedPreset.defaultFormula,
      paramValues,
      activeStageParams,
    });
  },

  setTapeSpeed: (speed: number) => {
    const normalized = speed === 7.5 || speed === 3.75 ? speed : 15;
    get().bridge?.postMessage({ type: 'set-speed', value: normalized });
    set({ tapeSpeed: normalized });
  },

  setOversample: (factor: number) => {
    const normalized = factor === 4 ? 4 : 2;
    get().bridge?.postMessage({ type: 'set-oversample', value: normalized });
    set({ oversample: normalized });
  },

  setFormula: (formula: string) => {
    get().bridge?.postMessage({ type: 'set-formula', value: formula });
    set({ formula });
  },

  setHeadroom: (headroom: number) => {
    get().bridge?.setParam('headroom', headroom, get().audioCtx?.currentTime ?? 0);
    set({ headroom });
  },

  setGlobalBypass: (bypassed: boolean) => {
    get().bridge?.postMessage({ type: 'set-bypass', value: bypassed });
    set({ globalBypassed: bypassed });
  },

  setParam: (name: string, value: number) => {
    const { bridge, audioCtx } = get();
    bridge?.setParam(name, value, audioCtx?.currentTime ?? 0);
    if (isParamKey(name)) {
      set((state) => ({
        paramValues: {
          ...state.paramValues,
          [name]: value,
        },
      }));
    }
  },

  postMessage: (msg) => {
    get().bridge?.postMessage(msg);
    if (msg.type === 'set-stage-param') {
      set((state) => ({
        activeStageParams: {
          ...state.activeStageParams,
          [msg.stageId]: {
            ...state.activeStageParams[msg.stageId],
            [msg.param]: true,
          },
        },
      }));
      return;
    }
    if (msg.type === 'clear-param-overrides' || msg.type === 'set-preset') {
      set({ activeStageParams: initActiveStageParams() });
    }
  },

  processOffline16x: async () => {
    const startState = get();
    if (startState.offlineProcessing) return;

    const loader = startState.loader;
    const sourceBuffer = loader?.getBuffer();
    if (!loader || !sourceBuffer) return;

    set({ offlineProcessing: true, offlineProgress: 0 });
    try {
      const renderState = get();
      const offlineCtx = new OfflineAudioContext(2, sourceBuffer.length, sourceBuffer.sampleRate);
      await offlineCtx.audioWorklet.addModule(getWorkletUrl());

      const node = new AudioWorkletNode(offlineCtx, 'tape-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          preset: renderState.machinePreset,
          oversample: 16,
          tapeSpeed: renderState.tapeSpeed,
          totalFrames: sourceBuffer.length,
        },
      });
      node.port.onmessage = (event: MessageEvent<WorkletResponse>) => {
        const data = event.data;
        if (data.type !== 'render-progress') return;
        const progress = Math.max(0, Math.min(1, data.progress));
        set((state) => {
          if (!state.offlineProcessing) return state;
          if (progress < 1 && progress - state.offlineProgress < 0.002) return state;
          return { offlineProgress: progress };
        });
      };

      const source = offlineCtx.createBufferSource();
      source.buffer = sourceBuffer;
      source.connect(node);
      node.connect(offlineCtx.destination);

      const bridge = new WorkletBridge(node);
      applyStateToWorklet(bridge, renderState, useStageParams.getState().stages, 16);

      source.start();
      const rendered = await offlineCtx.startRendering();
      set({ offlineProgress: 1 });
      bridge.postMessage({ type: 'dispose' });

      const blob = audioBufferToWav(rendered);
      const fileName = buildProcessedFileName(loader.getLoadedFileName());
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      console.error('[tape] Offline 16x processing failed', error);
    } finally {
      set({ offlineProcessing: false, offlineProgress: 0 });
    }
  },

  updateMeters: (vuDb: number[], peakDb: number[]) => {
    set({ vuDb, peakDb });
  },

  updateStageMeters: (levels: Record<string, StageMeterLevels>) => {
    const { scopeBuffers, scopeBufferIndex } = get();
    const nextIndex = (scopeBufferIndex + 1) % SCOPE_BUFFER_SIZE;

    for (const id of SCOPE_STAGE_IDS) {
      const stage = levels[id];
      if (!stage) continue;
      scopeBuffers[id][nextIndex] = {
        vuDb: stage.vuDb[1] ?? -60,
        gainDelta: (stage.vuDb[1] ?? -60) - (stage.vuDb[0] ?? -60),
        saturation: stage.saturation ?? 0,
      };
    }

    set({ stageMeters: levels, scopeBufferIndex: nextIndex });
  },

  updateTime: (current: number, duration: number) => {
    set({ currentTime: current, duration });
  },
}));
