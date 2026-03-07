# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A physically modeled tape saturation audio plugin implemented as a React web app with an AudioWorklet processor for real-time DSP. It emulates analog tape machines (Studer A810, Ampex ATR-102, MCI JH-24) through a 12-stage DSP chain.

## Design Philosophy

**Sound quality and physical accuracy are the top priorities.** This project aims for the most realistic and best-sounding tape emulation possible. CPU efficiency is not a concern — favor accuracy over performance optimizations. Never simplify or approximate DSP algorithms for the sake of reducing CPU usage.

## Commands

```bash
npm run dev          # Start Vite dev server
npm run build        # tsc + vite build (outputs to dist/)
npm test             # Run vitest tests once
npm run test:watch   # Run tests in watch mode
npm run test:worklet-physics  # Run worklet-level physical-constraint checks
```

To run a single test file:
```bash
npx vitest run src/dsp/__tests__/hysteresis.test.ts
```

When changing DSP, the worklet, or any code that can affect sound, run `npm test` before considering the work done. Also run the most relevant focused physics checks for the subsystem you touched, such as `npm run test:worklet-physics` or a targeted DSP test file. Do not introduce golden sound baselines or house-tone assertions unless they are backed by measured hardware captures or a documented analytical target.

## Architecture

The project uses a dual-layer architecture with message-based IPC between the main thread and audio thread:

**Main thread (React UI)**
- `src/App.tsx` — top-level component, view switching, file drag-drop
- `src/stores/audio-engine.ts` — Zustand store: AudioContext lifecycle, worklet bridge, file loading, playback, metering
- `src/stores/stage-params.ts` — Zustand store: per-stage parameters and preset management
- `src/audio/worklet-bridge.ts` — typed wrapper around AudioWorkletNode for UI↔worklet communication
- `src/audio/file-loader.ts` — decodes audio files and drives playback transport
- `src/types/messages.ts` — TypeScript message types for worklet IPC
- `src/types/stages.ts` — Stage definitions (12 stages)

**Audio thread (AudioWorklet)**
- `src/worklet/tape-processor.ts` — the core DSP processor (~740 lines); loaded as a separate Vite entry point into `dist/worklets/tape-processor.js`

**DSP modules** (`src/dsp/`): pure functions/classes used by the processor
- `hysteresis.ts` — Jiles-Atherton magnetic hysteresis model (core tape saturation)
- `amplifier.ts` — tube/transistor nonlinear amp models
- `transformer.ts` — input/output transformer saturation
- `eq-curves.ts` — NAB/IEC record/playback EQ curves
- `head-model.ts` — playback head gap loss and spacing loss
- `transport.ts` — wow and flutter simulation
- `noise.ts` — tape hiss generator
- `oversampling.ts` — 2x/4x oversampling for nonlinear stages
- `biquad.ts` — biquad filter
- `presets.ts` — machine preset definitions

**UI components** (`src/components/`)
- `compact/CompactView.tsx` — simplified single-panel view with all stage controls
- `graph/GraphView.tsx` — node-based signal-flow visualization using `@xyflow/react`
- `graph/nodes/StageNode.tsx` — interactive node per stage
- `graph/ScopePanel.tsx` — oscilloscope visualization of selected stages
- `transport/TransportBar.tsx` — play/pause/stop/seek
- `controls/` — reusable controls: `Knob`, `LevelMeter`, `Select`, `ToggleButton`, `Sparkline`, `MiniMeter`

## 12-Stage DSP Chain

Signal flows through these stages in order:
1. **inputXfmr** — Input transformer (saturable core, resonance)
2. **recordAmp** — Record amplifier (tube/transistor, oversampled 2–4x)
3. **recordEQ** — NAB/IEC pre-emphasis
4. **bias** — AC bias (controls tape reversibility)
5. **hysteresis** — Jiles-Atherton tape saturation (oversampled)
6. **head** — Playback head gap and spacing losses
7. **transport** — Wow and flutter
8. **noise** — Tape hiss injection
9. **playbackAmp** — Playback amplifier (oversampled)
10. **playbackEQ** — NAB/IEC de-emphasis
11. **outputXfmr** — Output transformer saturation
12. **output** — Final gain

Each stage supports bypass and per-parameter UI override. The worklet sends per-stage VU/peak metering and saturation depth back to the UI at ~60fps via `port.postMessage`.

## Build Configuration

- Two separate TypeScript configs: `tsconfig.app.json` (main app, DOM types) and `tsconfig.worklet.json` (AudioWorklet, ESNext, no DOM types)
- Vite bundles the worklet as a separate entry: `src/worklet/tape-processor.ts` → `dist/worklets/tape-processor.js`
- Tests live in `src/dsp/__tests__/` and cover each DSP module independently

## Key Patterns

- State flows unidirectionally: UI actions → Zustand stores → `worklet-bridge.postMessage` → `TapeProcessor` processes → meters posted back → stores update meters → UI re-renders
- DSP modules in `src/dsp/` are pure (no Web Audio API dependencies) so they can be unit tested with Vitest in a Node environment
- Oversampling is applied only to nonlinear stages (amplifiers, hysteresis) to prevent aliasing from the soft-clipping nonlinearities
