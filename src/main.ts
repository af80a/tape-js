/**
 * Tape Saturator — main application entry point.
 *
 * Creates the UI layout and wires it to the Web Audio API,
 * AudioWorklet processor, and file loader.
 */

import './styles/main.css';
import { Layout } from './ui/layout';
import { AudioFileLoader } from './audio/file-loader';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let tapeNode: AudioWorkletNode | null = null;
let loader: AudioFileLoader | null = null;
let layout: Layout | null = null;

// ---------------------------------------------------------------------------
// Audio context bootstrap
// ---------------------------------------------------------------------------

async function ensureAudioContext(): Promise<void> {
  if (audioCtx) return;

  audioCtx = new AudioContext();

  // Load the worklet module — Vite resolves the ?worker&url import at build
  // time, but we use import.meta.url based resolution for dev mode.
  const workletUrl = new URL('./worklet/tape-processor.ts', import.meta.url).href;
  await audioCtx.audioWorklet.addModule(workletUrl);

  // Create the tape processor node
  tapeNode = new AudioWorkletNode(audioCtx, 'tape-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      preset: 'studer',
      oversample: 2,
      tapeSpeed: 15,
    },
  });
  tapeNode.connect(audioCtx.destination);

  // Listen for meter data from the worklet
  tapeNode.port.onmessage = (e: MessageEvent) => {
    const data = e.data as { type: string; rms?: number[]; peak?: number[] };
    if (data.type === 'meters') {
      layout?.updateMeters(data.rms ?? [], data.peak ?? []);
    }
  };

  // Create the audio file loader, connected through the tape node
  loader = new AudioFileLoader(audioCtx, tapeNode);
  loader.setTimeUpdateCallback((current, duration) => {
    layout?.updateTime(current, duration);
  });
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init(): void {
  const app = document.getElementById('app');
  if (!app) return;

  layout = new Layout(app, {
    onParamChange: (name: string, value: number) => {
      const param = tapeNode?.parameters.get(name);
      if (param) {
        param.setValueAtTime(value, audioCtx?.currentTime ?? 0);
      }
    },

    onPresetChange: (preset: string) => {
      tapeNode?.port.postMessage({ type: 'set-preset', value: preset });
    },

    onSpeedChange: (speed: number) => {
      tapeNode?.port.postMessage({ type: 'set-speed', value: speed });
    },

    onOversampleChange: (factor: number) => {
      tapeNode?.port.postMessage({ type: 'set-oversample', value: factor });
    },

    onFileLoad: async (file: File) => {
      await ensureAudioContext();
      await loader!.loadFile(file);
      loader!.play();
    },

    onPlay: () => loader?.play(),
    onStop: () => loader?.stop(),
    onPause: () => loader?.pause(),
    onSeek: (time: number) => loader?.seek(time),
  });
}

init();
