import { create } from 'zustand';
import { AudioFileLoader } from '../audio/file-loader';
import { WorkletBridge, createWorkletBridge } from '../audio/worklet-bridge';
import { STAGE_IDS } from '../types/stages';

export interface StageMeterLevels {
  vuDb: number[];
  peakDb: number[];
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
  currentTime: number;
  duration: number;
  vuDb: number[];
  peakDb: number[];
  stageMeters: Record<string, StageMeterLevels>;

  // Actions
  ensureAudioContext: () => Promise<void>;
  loadFile: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setMachinePreset: (preset: string) => void;
  setTapeSpeed: (speed: number) => void;
  setOversample: (factor: number) => void;
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
  currentTime: 0,
  duration: 0,
  vuDb: [-20, -20],
  peakDb: [-20, -20],
  stageMeters: initStageMeterState(),

  ensureAudioContext: async () => {
    if (get().audioCtx) return;

    const audioCtx = new AudioContext();
    const bridge = await createWorkletBridge(audioCtx);
    const state = get();
    bridge.postMessage({ type: 'set-preset', value: state.machinePreset });
    bridge.postMessage({ type: 'set-speed', value: state.tapeSpeed });
    bridge.postMessage({ type: 'set-oversample', value: state.oversample });
    bridge.postMessage({ type: 'set-bypass', value: state.globalBypassed });

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
    get().bridge?.postMessage({ type: 'set-preset', value: preset });
    set({ machinePreset: preset });
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
    set({ stageMeters: levels });
  },

  updateTime: (current: number, duration: number) => {
    set({ currentTime: current, duration });
  },
}));
