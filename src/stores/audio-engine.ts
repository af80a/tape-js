import { create } from 'zustand';
import { AudioFileLoader } from '../audio/file-loader';
import { WorkletBridge, createWorkletBridge, getWorkletUrl } from '../audio/worklet-bridge';
import { STAGE_IDS, type StageId } from '../types/stages';
import type { WorkletMessage, WorkletResponse } from '../types/messages';
import { audioBufferToWav, buildProcessedFileName } from '../audio/wav-export';
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

export const SCOPE_BUFFER_SIZE = 100; // ~5 seconds at 50ms meter interval

const PARAM_KEYS = ['inputGain', 'bias', 'drive', 'saturation', 'ampDrive', 'wow', 'flutter', 'hiss', 'color', 'outputGain'] as const;
type ParamKey = (typeof PARAM_KEYS)[number];

const DEFAULT_PARAMS: Record<ParamKey, number> = {
  inputGain: 1.0,
  bias: 0.5,
  drive: 0.5,
  saturation: 0.5,
  ampDrive: 0.5,
  wow: 0.15,
  flutter: 0.1,
  hiss: 0.05,
  color: 0,
  outputGain: 1.0,
};

function isParamKey(name: string): name is ParamKey {
  return (PARAM_KEYS as readonly string[]).includes(name);
}

function isStageId(name: string): name is StageId {
  return (STAGE_IDS as readonly string[]).includes(name);
}

function initStageMeterState(): Record<string, StageMeterLevels> {
  const meters: Record<string, StageMeterLevels> = {};
  for (const id of STAGE_IDS) {
    meters[id] = { vuDb: [-60, -60], peakDb: [-60, -60] };
  }
  return meters;
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
  bump: string;
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
  activeStageParamKeys: Record<string, true>;

  // Actions
  toggleScope: () => void;
  ensureAudioContext: () => Promise<void>;
  loadFile: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setMachinePreset: (preset: string) => void;
  setTapeSpeed: (speed: number) => void;
  setOversample: (factor: number) => void;
  setFormula: (formula: string) => void;
  setBump: (bump: string) => void;
  setHeadroom: (headroom: number) => void;
  setGlobalBypass: (bypassed: boolean) => void;
  setParam: (name: string, value: number) => void;
  postMessage: (msg: Parameters<WorkletBridge['postMessage']>[0]) => void;
  processOffline16x: () => Promise<void>;
  updateMeters: (vuDb: number[], peakDb: number[]) => void;
  updateStageMeters: (levels: Record<string, StageMeterLevels>) => void;
  updateTime: (current: number, duration: number) => void;
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
  formula: '456',
  bump: 'flat',
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
  paramValues: { ...DEFAULT_PARAMS },
  activeStageParamKeys: {},

  toggleScope: () => set((s) => ({ scopeOpen: !s.scopeOpen })),

  ensureAudioContext: async () => {
    if (get().audioCtx) return;

    const audioCtx = new AudioContext();
    const bridge = await createWorkletBridge(audioCtx);
    const state = get();
    bridge.postMessage({ type: 'set-preset', value: state.machinePreset });
    // Send amp type before oversample so initDSP (triggered by set-oversample)
    // already knows the correct amp type and doesn't recreate amps redundantly.
    const ampType = (useStageParams.getState().stages.recordAmp.variant ?? 'transistor') as 'tube' | 'transistor';
    bridge.postMessage({ type: 'set-amp-type', value: ampType });
    bridge.postMessage({ type: 'set-speed', value: state.tapeSpeed });
    bridge.postMessage({ type: 'set-oversample', value: state.oversample });
    bridge.postMessage({ type: 'set-formula', value: state.formula });
    bridge.postMessage({ type: 'set-bump', value: state.bump });
    bridge.postMessage({ type: 'set-bypass', value: state.globalBypassed });
    for (const key of PARAM_KEYS) {
      bridge.setParam(key, state.paramValues[key], 0);
    }
    bridge.setParam('headroom', state.headroom, 0);

    bridge.onMessage((msg) => {
      if (msg.type === 'meters') {
        get().updateMeters(msg.vuDb, msg.peakDb);
      } else if (msg.type === 'stage-meters') {
        get().updateStageMeters(msg.levels);
      } else if (msg.type === 'debug-stats') {
        const {
          timerSource,
          overrunsPerSec,
          nanAmpCount,
          nanHystCount,
          outRms,
          outDc,
          outPeak,
          outClampHits,
          outNonFinite,
          lrImbalanceDb,
          maxProcessMs,
          avgProcessMs,
          avgRecordMs,
          avgPlaybackMs,
          budgetMs,
        } = msg as unknown as {
          timerSource?: 'perf' | 'date';
          overrunsPerSec: number; nanAmpCount: number; nanHystCount?: number;
          outRms?: number[]; outDc?: number[]; outPeak?: number[];
          outClampHits?: number[]; outNonFinite?: number[]; lrImbalanceDb?: number;
          maxProcessMs: number; avgProcessMs: number;
          avgRecordMs: number; avgPlaybackMs: number; budgetMs: number;
        };
        const fmt = (arr?: number[]) => (arr && arr.length ? arr.join('/') : 'n/a');
        console.log(
          `[tape] timer=${timerSource ?? 'unknown'} max=${maxProcessMs}ms avg=${avgProcessMs}ms (rec=${avgRecordMs} pb=${avgPlaybackMs}) budget=${budgetMs}ms | overruns/s=${overrunsPerSec} | nanAmp=${nanAmpCount} | nanHyst=${nanHystCount ?? 0} | rms=${fmt(outRms)} peak=${fmt(outPeak)} dc=${fmt(outDc)} clamp=${fmt(outClampHits)} nonfinOut=${fmt(outNonFinite)} lrDb=${lrImbalanceDb ?? 0}`
        );
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

  setMachinePreset: (preset: string) => {
    // When changing machines, reset the character controls to match the machine's defaults
    // so the user gets the true machine experience out of the box.
    let defaultFormula = '456';
    if (preset === 'studer') defaultFormula = '900';
    else if (preset === 'mci') defaultFormula = '499';

    get().bridge?.postMessage({ type: 'set-preset', value: preset });
    get().bridge?.postMessage({ type: 'set-formula', value: defaultFormula });
    get().bridge?.postMessage({ type: 'set-bump', value: 'flat' });
    // Amp type comes from the preset definition via initDSP — no separate
    // set-amp-type needed. useStageParams.loadPreset sets the UI variant
    // from preset.ampType via buildStageStates.

    set({
      machinePreset: preset,
      formula: defaultFormula,
      bump: 'flat',
      activeStageParamKeys: {},
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

  setBump: (bump: string) => {
    get().bridge?.postMessage({ type: 'set-bump', value: bump });
    set({ bump });
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
      const key = `${msg.stageId}.${msg.param}`;
      set((state) => ({
        activeStageParamKeys: {
          ...state.activeStageParamKeys,
          [key]: true,
        },
      }));
      return;
    }
    if (msg.type === 'clear-param-overrides' || msg.type === 'set-preset') {
      set({ activeStageParamKeys: {} });
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

      const post = (message: WorkletMessage) => node.port.postMessage(message);
      post({ type: 'set-preset', value: renderState.machinePreset });
      post({ type: 'set-speed', value: renderState.tapeSpeed });
      post({ type: 'set-oversample', value: 16 });
      post({ type: 'set-formula', value: renderState.formula });
      post({ type: 'set-bump', value: renderState.bump });
      post({ type: 'set-bypass', value: renderState.globalBypassed });

      for (const key of PARAM_KEYS) {
        node.parameters.get(key)?.setValueAtTime(renderState.paramValues[key], 0);
      }
      node.parameters.get('headroom')?.setValueAtTime(renderState.headroom, 0);

      const { stages } = useStageParams.getState();
      for (const stageId of STAGE_IDS) {
        const stage = stages[stageId];
        post({ type: 'set-stage-bypass', stageId, value: stage.bypassed });
        if (stage.variant) {
          post({ type: 'set-stage-variant', stageId, value: stage.variant });
        }
      }

      for (const key of Object.keys(renderState.activeStageParamKeys)) {
        const dot = key.indexOf('.');
        if (dot <= 0) continue;
        const stageIdRaw = key.slice(0, dot);
        const param = key.slice(dot + 1);
        if (!isStageId(stageIdRaw)) continue;
        const value = stages[stageIdRaw]?.params[param];
        if (typeof value !== 'number') continue;
        post({ type: 'set-stage-param', stageId: stageIdRaw, param, value });
      }

      source.start();
      const rendered = await offlineCtx.startRendering();
      set({ offlineProgress: 1 });
      post({ type: 'dispose' });

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
