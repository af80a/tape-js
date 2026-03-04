import { create } from 'zustand';
import { AudioFileLoader } from '../audio/file-loader';
import { WorkletBridge, createWorkletBridge } from '../audio/worklet-bridge';
import { STAGE_IDS } from '../types/stages';

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
  ampType: 'tube' | 'transistor';
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
  setAmpType: (ampType: 'tube' | 'transistor') => void;
  setBump: (bump: string) => void;
  setHeadroom: (headroom: number) => void;
  setGlobalBypass: (bypassed: boolean) => void;
  setParam: (name: string, value: number) => void;
  postMessage: (msg: Parameters<WorkletBridge['postMessage']>[0]) => void;
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
  ampType: 'transistor',
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

  toggleScope: () => set((s) => ({ scopeOpen: !s.scopeOpen })),

  ensureAudioContext: async () => {
    if (get().audioCtx) return;

    const audioCtx = new AudioContext();
    const bridge = await createWorkletBridge(audioCtx);
    const state = get();
    bridge.postMessage({ type: 'set-preset', value: state.machinePreset });
    bridge.postMessage({ type: 'set-speed', value: state.tapeSpeed });
    bridge.postMessage({ type: 'set-oversample', value: state.oversample });
    bridge.postMessage({ type: 'set-formula', value: state.formula });
    bridge.postMessage({ type: 'set-amp-type', value: state.ampType });
    bridge.postMessage({ type: 'set-bump', value: state.bump });
    bridge.postMessage({ type: 'set-bypass', value: state.globalBypassed });
    bridge.setParam('headroom', state.headroom, 0);

    bridge.onMessage((msg) => {
      if (msg.type === 'meters') {
        get().updateMeters(msg.vuDb, msg.peakDb);
      } else if (msg.type === 'stage-meters') {
        get().updateStageMeters(msg.levels);
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
    let defaultAmpType: 'tube' | 'transistor' = 'transistor';
    if (preset === 'ampex') defaultFormula = '456';
    if (preset === 'studer') defaultFormula = '900';
    if (preset === 'mci') {
      defaultFormula = '499';
      defaultAmpType = 'tube';
    }

    get().bridge?.postMessage({ type: 'set-preset', value: preset });
    get().bridge?.postMessage({ type: 'set-formula', value: defaultFormula });
    get().bridge?.postMessage({ type: 'set-amp-type', value: defaultAmpType });
    get().bridge?.postMessage({ type: 'set-bump', value: 'flat' }); // Reset bump to flat

    set({ 
      machinePreset: preset,
      formula: defaultFormula,
      ampType: defaultAmpType,
      bump: 'flat',
    });
  },

  setTapeSpeed: (speed: number) => {
    const normalized = speed === 7.5 || speed === 3.75 ? speed : 15;
    get().bridge?.postMessage({ type: 'set-speed', value: normalized });
    set({ tapeSpeed: normalized });
  },

  setOversample: (factor: number) => {
    const normalized = factor === 8 ? 8 : factor === 4 ? 4 : 2;
    get().bridge?.postMessage({ type: 'set-oversample', value: normalized });
    set({ oversample: normalized });
  },

  setFormula: (formula: string) => {
    get().bridge?.postMessage({ type: 'set-formula', value: formula });
    set({ formula });
  },

  setAmpType: (ampType: 'tube' | 'transistor') => {
    get().bridge?.postMessage({ type: 'set-amp-type', value: ampType });
    set({ ampType });
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
  },

  postMessage: (msg) => {
    get().bridge?.postMessage(msg);
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
