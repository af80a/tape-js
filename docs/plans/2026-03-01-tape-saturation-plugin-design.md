# Tape Saturation Plugin — Design Document

## Overview

A physically modeled tape saturation plugin built as a standalone web application using Web Audio API (TypeScript + Vite). Models the complete signal path of a reel-to-reel tape machine including transformers, amplifiers, magnetic hysteresis, playback head, and mechanical transport.

## Technology

- **Runtime:** Web Audio API (AudioWorklet)
- **Language:** TypeScript
- **Build:** Vite
- **UI:** Vanilla DOM (no framework)
- **Testing:** Vitest

## Signal Chain

Models the physical path of audio through a tape recorder:

```
Input → Input Transformer → Record Amp → Bias + Record EQ → [TAPE: Hysteresis]
     → Playback Head → Playback Amp → Playback EQ → Output Transformer → Output
                                ↑
                        Transport (Wow/Flutter)
                                ↑
                           Tape Hiss
```

## Component Models

### 1. Input Transformer

Models magnetic core saturation of the input transformer:

- **Core saturation** — Langevin function-based soft clipping. Even harmonics, low-end thickening.
- **Inductance rolloff** — HF rolloff from winding inductance + capacitance with resonant peak.
- **LF coupling** — Low-frequency rolloff from finite primary inductance ("transformer bump").
- Implementation: nonlinear transfer function + 2nd-order bandpass characteristic.

### 2. Record Amplifier

Models tube or transistor gain stage:

- **Tube mode** — asymmetric soft clipping (even harmonics), polynomial or modified tanh.
- **Transistor mode** — symmetric clipping (odd harmonics).
- Subtle coloration — clean amplifiers that contribute character when driven.

### 3. AC Bias Oscillator

High-frequency AC bias mixed with audio before recording:

- Bias level controls linearity of the recording process.
- Under-biasing = more distortion/harmonics.
- Over-biasing = duller sound, less HF content.
- Key creative parameter.

### 4. Record Pre-Emphasis EQ

NAB or IEC equalization applied before recording:

- Boosts highs to compensate for tape's natural HF loss.
- Biquad filter chain matching standard curves.
- Curve determined by tape speed setting.

### 5. Magnetic Hysteresis (Tape Core)

Heart of the plugin. Jiles-Atherton model for nonlinear H→M relationship:

- **Saturation magnetization (Ms)** — max tape magnetization.
- **Coercivity (Hc)** — resistance to demagnetization.
- **Anhysteretic curve** — Langevin function for ideal magnetization.
- **Domain wall pinning (k)** — hysteresis loop width.
- **Reversibility (c)** — anhysteretic vs. irreversible path balance.

Solved per-sample with RK4 numerical ODE solver. Naturally produces:

- Soft saturation/compression
- Odd and even harmonic generation
- Level-dependent frequency response
- Characteristic "tape warmth"

### 6. Playback Head

Models physical head characteristics:

- **Head bump** — resonant LF boost from head geometry (~60-100 Hz).
- **Gap loss** — HF rolloff: `sinc(pi * d / lambda)` where d = gap width.
- **Spacing loss** — exponential HF loss: `e^(-2pi * d / lambda)`.

### 7. Playback Amplifier

Same model as record amp with different default parameters. Generally cleaner.

### 8. Playback De-Emphasis EQ

Complementary NAB/IEC curve. Together with record EQ defines tape speed character.

### 9. Output Transformer

Same model as input transformer with different parameters (impedance ratio, core material).

### 10. Transport Model (Wow & Flutter)

Physical model of tape transport mechanics:

- **Wow** — low-frequency speed variation from reel eccentricity (~0.5-2 Hz).
- **Flutter** — higher-frequency variation from capstan irregularities (~5-10 Hz).
- Pitch modulation via variable delay line with Lagrange interpolation.

### 11. Tape Noise

Shaped noise matching tape hiss spectrum — emphasis in 2-8 kHz range.

### 12. Oversampling

Prevents aliasing from nonlinear processing:

- Half-band FIR filters for up/downsampling.
- Modes: 1x (off), 2x (default), 4x (high quality).
- Only hysteresis stage runs at oversampled rate.

## Parameters

| Parameter | Physical Meaning | Range | Default |
|-----------|-----------------|-------|---------|
| Input Gain | Record level | -12dB to +12dB | 0dB |
| Machine Type | Preset configuration | Studer / Ampex / MCI | Studer |
| Tape Speed | EQ curves, HF behavior | 3.75 / 7.5 / 15 ips | 15 ips |
| Bias | AC bias level | 0-100% | 50% |
| Saturation | Tape formulation (Ms) | Low / Med / High | Med |
| Wow | Reel eccentricity depth | 0-100% | 15% |
| Flutter | Capstan irregularity depth | 0-100% | 10% |
| Hiss | Noise floor level | 0-100% | 5% |
| Output Gain | Makeup gain | -12dB to +12dB | 0dB |
| Mix | Dry/wet blend | 0-100% | 100% |
| Oversampling | Aliasing prevention | 1x / 2x / 4x | 2x |

## Machine Presets

Presets configure transformer characteristics, amp type, EQ standard, and head parameters:

- **Studer A810** — clean, transparent, IEC EQ, tube electronics
- **Ampex ATR-102** — warm, thick low end, NAB EQ, transformer coloration
- **MCI JH-24** — punchy, slightly grittier, NAB EQ, transistor electronics

Users can tweak individual parameters after selecting a preset.

## Project Structure

```
src/
├── main.ts                  # App entry, AudioContext setup, file loading
├── worklet/
│   └── tape-processor.ts    # AudioWorkletProcessor, full DSP chain
├── dsp/
│   ├── hysteresis.ts        # Jiles-Atherton model + RK4 solver
│   ├── transformer.ts       # Transformer core saturation + frequency model
│   ├── amplifier.ts         # Tube/transistor amp stage
│   ├── head-model.ts        # Head bump, gap loss, spacing loss
│   ├── eq-curves.ts         # NAB/IEC pre-emphasis & de-emphasis
│   ├── transport.ts         # Wow/flutter variable delay line
│   ├── bias.ts              # AC bias oscillator
│   ├── noise.ts             # Shaped tape hiss
│   ├── oversampling.ts      # Half-band FIR up/downsampling
│   └── presets.ts           # Machine type presets
├── ui/
│   ├── controls.ts          # Knob/slider components (vanilla DOM)
│   ├── meter.ts             # Input/output level meters
│   └── layout.ts            # Main UI layout and wiring
└── audio/
    └── file-loader.ts       # Audio file loading, decoding, playback
```

## UI Design

Minimal, modern, dark theme:

- Rotary knobs (CSS arc + pointer)
- Level meters (in/out), ~30fps update via requestAnimationFrame
- Drag-and-drop + file picker for audio loading
- Playback controls with seek bar
- Numeric value display below each knob
- Responsive (desktop + tablet)

## Data Flow

1. User loads audio file (drag-and-drop or picker)
2. File decoded to AudioBuffer
3. AudioBufferSourceNode → TapeProcessorNode (worklet) → GainNode → destination
4. UI sends parameter changes via AudioParam (sample-accurate)
5. Level metering data sent from worklet to main thread via port.postMessage()

## Testing

- Unit tests for each DSP module (pure functions, no Web Audio dependency)
- Key tests: hysteresis harmonic content, oversampling filter response, EQ curve accuracy
- Integration: full chain produces valid output (no NaN/Infinity)
- Output clamping for speaker protection

## Browser Support

Chrome, Edge, Firefox, Safari (all support AudioWorklet).
