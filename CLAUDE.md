# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Physically modeled tape saturation web audio plugin. Emulates analog tape machines (Studer A810, Ampex ATR-102, MCI JH-24) with physics-based DSP including Jiles-Atherton hysteresis, tube amplifier circuits, transformer saturation, head modeling, and transport wow/flutter.

## Commands

```bash
npm run dev          # Vite dev server
npm run build        # TypeScript check + Vite build
npm test             # Run all tests (vitest run)
npm run test:watch   # Tests in watch mode
npx vitest run src/dsp/__tests__/amplifier.test.ts  # Single test file
```

## Architecture

### Two Compilation Targets

The project has separate TypeScript configs for the main app (`tsconfig.app.json`) and AudioWorklet (`tsconfig.worklet.json`). The worklet runs in `AudioWorkletGlobalScope` — it has no DOM access and uses `@types/audioworklet` typings. Vite builds the worklet to `/worklets/tape-processor.js` separately from the main bundle.

### DSP Signal Chain (in `src/worklet/tape-processor.ts`)

```
Input → InputXfmr → RecordAmp → RecordEQ → [Bias] → [Oversampled: Hysteresis]
→ Head → Transport → PlaybackAmp → PlaybackEQ → OutputXfmr → Noise → Output
```

Each stage is a standalone class in `src/dsp/`. The worklet instantiates per-channel DSP objects and wires them in sequence. Stages can be individually bypassed.

### Key DSP Modules (`src/dsp/`)

- **hysteresis.ts** — Jiles-Atherton model with RK4 solver (tape saturation core)
- **amplifier.ts** — Cohen-Helie 12AX7 nodal DK-method (tube) or tanh clipping (transistor)
- **transformer.ts** — Flux-based B-H curve + LF coupling + HF resonance + eddy losses
- **head-model.ts** — Biquad filters (bump/dip) + FIR loss filter (sinc gap + exponential spacing)
- **transport.ts** — Variable delay line with cubic Lagrange interpolation for wow/flutter
- **eq-curves.ts** — NAB/IEC equalization from standard time constants
- **oversampling.ts** — FIR-based 2x/4x with windowed-sinc (Blackman) anti-aliasing
- **presets.ts** — Machine presets with tape formulation parameters (k, c, alpha)

### Worklet ↔ Main Thread Communication

`src/audio/worklet-bridge.ts` wraps `AudioWorkletNode` with typed messaging. Messages flow both ways:
- **To worklet:** preset changes, speed, oversample factor, per-stage bypass/param overrides
- **From worklet:** VU/peak meters and per-stage level data

The worklet pre-allocates scratch buffers for zero-GC audio processing.

### UI Layer

React 19 with two view modes:
- **CompactView** — Knob-based rack layout (`src/components/`)
- **GraphView** — Signal flow node graph using `@xyflow/react` (`src/components/graph/`)

State managed by Zustand (`src/stores/`):
- **useAudioEngine** — Audio context, playback, metering
- **useStageParams** — Per-stage parameters, bypass state, variant selection

### Stage System

Stages are identified by `StageId` (defined in `src/types/stages.ts`, mirrored in the worklet). Each stage has: bypass state, optional variant (tube/transistor, NAB/IEC), and a param bag. The worklet mirrors `StageId` locally to avoid cross-boundary imports.

## Testing

All tests are in `src/dsp/__tests__/`. Tests validate DSP correctness: numerical accuracy of physical models, filter responses, allocation behavior (zero-GC guarantees), and parameter setter coverage. Tests run in Node (no browser/AudioContext needed) since DSP classes are pure math.

## Build Notes

- Vite config has a custom `entryFileNames` function that routes the worklet entry to `worklets/tape-processor.js`
- Dev mode loads the worklet from `/src/worklet/tape-processor.ts` (Vite module); prod from `/worklets/tape-processor.js`
- `docs/review-physical-accuracy.md` contains a detailed audit of model accuracy vs physical reference with prioritized improvement roadmap
