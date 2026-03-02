# Physical Accuracy Review — Tape Saturation Plugin

Comprehensive review comparing the current implementation against the design
documents and known physical behavior of real tape machines. The goal: identify
gaps between our simulation and reality, prioritized by audible impact.

---

## Executive Summary

The implementation is solid and already well ahead of most tape emulation
plugins. The DK-method amplifier circuit simulation, flux-based transformer
model, and Jiles-Atherton hysteresis are all physically grounded. However,
several areas have significant gaps that would materially improve sonic
authenticity:

| Priority | Issue | Audible Impact |
|----------|-------|---------------|
| **Critical** | AC bias model can't work at achievable sample rates | Bias interaction is the core of tape recording character |
| **Critical** | Head model uses lowpass instead of sinc gap loss | Missing the characteristic HF rolloff shape |
| **High** | Wow/flutter is too simple (pure sines) | Sounds "seasick" rather than organically wobbly |
| **High** | Noise model is purely additive, missing modulation noise | Real tape noise breathes with the signal |
| **High** | EQ curves use 2nd-order shelves instead of 1st-order | Wrong slope for NAB/IEC standards |
| **Medium** | Sag parameters diverge from design doc | Affects tube compression character |
| **Medium** | No per-preset tape formulation parameters | All presets share identical hysteresis character |
| **Medium** | Missing spacing loss in head model | Affects HF character, especially "vintage" sounds |
| **Low** | Oversampler allocates per call | GC pressure in audio thread |
| **Low** | Missing dry/wet mix | Design doc specifies it |

---

## 1. AC Bias Model — CRITICAL

**Files:** `src/dsp/bias.ts`, `src/dsp/hysteresis.ts`, `src/worklet/tape-processor.ts`

### The Problem

The current approach explicitly generates an 80 kHz sine carrier and adds it
to the signal before hysteresis processing. This is physically correct in
principle — real machines DO add a ~80-150 kHz bias signal — but it fails at
achievable digital sample rates.

The `BiasOscillator` caps frequency at `0.4 * sampleRate`:
- At 44.1 kHz, 2x OS: effective fs = 88.2 kHz → bias capped at **35.3 kHz**
- At 48 kHz, 4x OS: effective fs = 192 kHz → bias capped at **76.8 kHz**

Even at maximum oversampling, the bias carrier has only ~3-4 cycles per period
of a 10 kHz audio signal, compared to 8-15 cycles in a real machine. This means
the bias carrier doesn't properly linearize the hysteresis curve at high audio
frequencies. Additionally, the nonlinear interaction between the bias carrier
and the hysteresis model creates severe aliasing products that fold back into
the audio band.

### What the Chow Tape Model Does

Jatin Chowdhury faced the same problem and solved it in his V2+ implementation
by **removing the explicit bias oscillator entirely**. Instead, the bias
parameter maps directly to the Jiles-Atherton `c` (reversibility) coefficient:

```
c = sqrt(1 - width) - 0.01
```

High effective bias → high `c` → more reversible magnetization → narrower
hysteresis loop → more linear transfer. This models the *effect* of AC bias
without needing to simulate the carrier, eliminating both the sample rate
limitation and the aliasing problem.

### Recommended Fix

1. Remove the `BiasOscillator` from the oversampled DSP chain
2. Map the bias parameter to the hysteresis `c` coefficient:
   - Bias = 0 (underbias): `c` ≈ 0.01 → wide hysteresis, lots of distortion
   - Bias = 0.5 (optimal): `c` ≈ 0.7 → moderately linear
   - Bias = 1.0 (overbias): `c` ≈ 0.99 → very linear, HF loss
3. Keep the `BiasOscillator` class but repurpose it as an optional "vintage"
   effect or remove it from the signal chain
4. The bias stage in the UI can remain but should control the hysteresis `c`
   parameter rather than an oscillator amplitude

This eliminates an entire stage from the oversampled loop (performance win)
while being MORE physically accurate.

---

## 2. Head Model — CRITICAL

**File:** `src/dsp/head-model.ts`

### Current Implementation

Three biquad filters: peaking for bump, peaking for dip, lowpass for gap loss.

### Gap Loss: Missing Sinc Response

The design doc specifies `sinc(π * d / λ)` gap loss, but the implementation
uses a simple lowpass filter at `tapeSpeed * 1200 Hz`. The real gap loss
function is:

```
H_gap(f) = sin(π * g * f / v) / (π * g * f / v)
```

Where `g` = gap width, `v` = tape speed, `f` = frequency. This produces:
- A gradual rolloff that accelerates at higher frequencies
- An **extinction null** at `f = v / g` (where gap width = wavelength)
- Sidelobes above the null

For a typical 2 µm playback gap at 15 ips (0.381 m/s):
- First null at ~190 kHz (above audible range)
- But at 7.5 ips: null at ~95 kHz
- At 3.75 ips: null at ~47 kHz (now affecting the top octave)

A simple lowpass completely misses this shape. The rolloff is gentler than
a 2nd-order lowpass in the passband but steeper near the null.

### Missing: Spacing Loss (Wallace Equation)

The design doc specifies spacing loss `e^(-2π * d / λ)` but it's not
implemented at all. The Wallace spacing loss:

```
H_spacing(f) = exp(-2π * d * f / v)
```

This is an **exponential** HF rolloff — loss of 54.6 dB per wavelength of
spacing. For well-maintained tape (d ≈ 0.5 µm):
- At 15 ips, 20 kHz: ~1.4 dB loss
- At 7.5 ips, 20 kHz: ~2.8 dB loss

For worn heads or degraded tape (d ≈ 5 µm):
- At 15 ips, 20 kHz: ~14 dB loss

This is a significant contributor to the "vintage" or "worn" tape character.

### Recommended Fix: FIR Loss Filter

Follow the approach from the Chow Tape Model (`LossFilter.cpp`):

1. Compute the combined frequency response `H[k]` at N frequency bins:
   ```
   H[k] = sinc(π*g*f[k]/v) * exp(-2π*d*f[k]/v)
   ```
2. Convert to a short FIR filter (32-64 taps) via inverse DCT
3. Apply as a per-sample FIR convolution
4. Recalculate coefficients when tape speed or head parameters change

**Per-preset gap widths** (estimated from machine specs):

| Machine | Playback Gap | Spacing |
|---------|-------------|---------|
| Studer A810 | 1.5 µm | 0.5 µm |
| Ampex ATR-102 | 2.0 µm | 0.8 µm |
| MCI JH-24 | 4.0 µm | 1.2 µm |

### Head Bump Frequency

The current formula `tapeSpeedIps * 3.67` gives 55 Hz at 15 ips. Real
measurements show:
- 15 ips: 40-80 Hz (our 55 Hz is reasonable)
- 7.5 ips: 20-40 Hz
- 30 ips: 100-150 Hz

The formula is acceptable but could be parameterized per preset since
different head geometries produce different bump frequencies.

---

## 3. Wow & Flutter Model — HIGH

**File:** `src/dsp/transport.ts`

### Current Implementation

Single sine oscillator for wow (1.2 Hz) + primary + secondary harmonic for
flutter (6.5 Hz). Per-channel phase offsets for stereo.

### Problem: Too Perfect

Real wow/flutter is NOT sinusoidal. It's a **quasi-random process** with
contributions from multiple mechanical sources:

- Reel eccentricity: fundamental at supply/takeup reel speeds (varies!)
- Capstan: multiple components from bearing, pulley
- Idler wheels: additional frequencies
- Guide rollers: high-frequency micro-flutter (50-500 Hz range)
- Tape tension variations: adds low-frequency drift

A pure sine sounds "seasick" — obviously periodic and artificial. Real
wow/flutter has a broadband spectral character with peaks at the dominant
mechanical frequencies but significant noise between them.

### Recommended Fix

Replace the two-sine model with a more complex modulation source:

```
modulation = lowpass_noise(1.5 Hz) * wowDepth          // wow: filtered noise
           + sin(wowPhase) * wowDepth * 0.3            // wow: residual sine component
           + bandpass_noise(4-10 Hz) * flutterDepth     // flutter: filtered noise
           + sin(flutterPhase) * flutterDepth * 0.3     // flutter: residual sine
           + highpass_noise(50 Hz) * scrapeFlutter       // scrape flutter
```

Use first-order lowpass-filtered white noise for the random components.
The sine components provide the dominant spectral peaks while the noise
fills in the realistic broadband character.

Also: the wow frequency should **drift** slightly over time (real reel speed
varies as tape moves from one reel to the other and reel diameter changes).

---

## 4. Noise Model — HIGH

**File:** `src/dsp/noise.ts`

### Current Implementation

White noise → 4 kHz peaking boost → 200 Hz HPF, scaled by level.

### Missing: Modulation Noise

The most characteristic property of tape noise is that it's **signal-dependent**.
Real tape has two distinct noise components:

1. **Bias noise** (additive): present even with no signal, caused by random
   magnetic domain orientation. This is what the current model approximates.

2. **Modulation noise** (signal-dependent): noise amplitude varies with the
   recorded signal level. Caused by magnetic domain irregularities and tape
   surface asperities. When signal is present, the noise increases, particularly
   at frequencies near the signal. This is typically 10-20 dB below the signal.

Modulation noise is what makes tape noise "breathe" with the music — it rises
when the signal is loud and fades in quiet passages. This is fundamentally
different from constant additive noise.

### Missing: Better Spectral Shape

Real tape hiss has a more complex spectrum than a single 4 kHz peak:
- 1/f (pink) character below ~1 kHz
- Broad emphasis in the 2-8 kHz range
- Gradual rolloff above ~10 kHz
- The exact shape depends on tape formulation and speed

### Recommended Fix

```typescript
process(inputLevel: number): number {
  if (this.level < 0.001) return 0;

  const white = Math.random() * 2 - 1;

  // Shaped noise (existing path)
  let y = this.shape.process(white);
  y = this.hpf.process(y);

  // Additive component (bias noise)
  const additive = y * this.level * 0.01;

  // Modulation noise: amplitude follows signal envelope
  const modulationDepth = 0.3;  // ratio of modulation to additive noise
  const modulation = y * this.level * 0.01 * modulationDepth
                   * Math.abs(inputLevel);

  return additive + modulation;
}
```

The `inputLevel` would be the signal amplitude at the point where noise is
injected. This requires passing the current sample level into the noise
generator from the tape processor.

---

## 5. EQ Curves — HIGH

**File:** `src/dsp/eq-curves.ts`

### Current Implementation

High-shelf and low-shelf biquad filters (2nd-order) with:
- HF: ±10 dB at corner frequency from time constant
- LF: ±6 dB at corner frequency (NAB only)

### Problem: Wrong Filter Order

NAB and IEC equalization curves are defined by **first-order** time constants
that produce 6 dB/octave (20 dB/decade) shelving characteristics. The
standard curves are:

```
H_NAB(f) = (1 + j*f/f2) / (1 + j*f/f1)
```

Where f1 and f2 are the corner frequencies derived from T1 and T2.

Using second-order (biquad) shelving filters produces:
- Steeper transition slopes (depends on Q)
- Different phase response
- Potential Q-dependent ringing near the corner

This means the record pre-emphasis and playback de-emphasis don't properly
complement each other, which accumulates error across the record → playback
chain.

### Recommended Fix

Use first-order shelf filters. A first-order high shelf is:

```
b0 = A * tan(w0/2) + 1     b1 = A * tan(w0/2) - 1
a0 = A * tan(w0/2) + A     a1 = A * tan(w0/2) - A
```

Where `A = 10^(gainDb/20)` and `w0 = 2π * fc / fs`.

Or equivalently, implement as a single-pole/single-zero filter:

```
y[n] = b0 * x[n] + b1 * x[n-1] - a1 * y[n-1]
```

This exactly matches the standard time-constant-based EQ specification.

Also: The gain values (10 dB, 6 dB) are somewhat arbitrary. Real NAB/IEC
curves are defined purely by the time constants — the gain is whatever falls
out of the transfer function shape. A correct implementation would derive the
filter directly from the time constants rather than choosing a fixed gain.

---

## 6. Power Supply Sag Parameters — MEDIUM

**File:** `src/dsp/amplifier.ts`

### Design Doc vs. Implementation

| Parameter | Design Doc | Implementation | Ratio |
|-----------|-----------|---------------|-------|
| R_OUT | 500-1000 Ω | 5000 Ω | 5-10x higher |
| C_filter1 | 47 µF | 10 µF | 4.7x smaller |
| C_filter2 | 22 µF | 22 µF | Match |
| R_filter | 4.7 kΩ | 4.7 kΩ | Match |
| R_bleeder | 220 kΩ | 220 kΩ | Match |

The mismatched values produce different sag dynamics:

**Design doc:** τ1 = R_OUT × C1 = 750 × 47e-6 = **35 ms** — faster attack,
more responsive sag that follows transients.

**Implementation:** τ1 = R_OUT × C1 = 5000 × 10e-6 = **50 ms** — slower,
more sluggish sag.

The code comments say "tuned for audible effect," but for physical accuracy,
the design doc values should be used. The faster sag produces more of the
"breathing" compression character that defines tube power supply interaction.

### Recommended Fix

Update `SAG_R_OUT` to ~750 and `SAG_C1` to 47e-6 to match the design doc.
This will make sag respond faster to transients (more audible compression)
and recover more quickly (more "bounce").

---

## 7. Per-Preset Tape Formulation — MEDIUM

**Files:** `src/dsp/presets.ts`, `src/dsp/hysteresis.ts`

### Current State

All three presets share the same default hysteresis parameters:
- `k` = 0.47875 (pinning/coercivity) — hardcoded
- `c` = computed from width only
- `alpha` = 1.6e-3 (inter-domain coupling) — hardcoded

Only `drive` and `saturation` vary per preset, which control `a` and `Ms`.

### Physical Reality

Different tape machines use different tape stocks with markedly different
magnetic properties:

| Tape Stock | Era | Typical Ms | Coercivity (k) | Character |
|-----------|-----|-----------|----------------|-----------|
| 3M 206 | 1960s | Lower | Lower (0.3-0.4) | Warm, saturates easily |
| Ampex 456 | 1970s | Medium | Medium (0.45-0.55) | Classic punch |
| Quantegy GP9 | 1980s+ | Higher | Higher (0.55-0.7) | Extended headroom, cleaner |

### Recommended Fix

Add tape formulation parameters to the preset definition:

```typescript
interface MachinePreset {
  // ... existing fields ...
  tapeFormulation: {
    k: number;      // pinning (coercivity proxy)
    c: number;      // reversibility baseline (before bias adjustment)
    alpha: number;  // inter-domain coupling
  };
}
```

Studer A810 (typically used with modern tape): k=0.55, alpha=1.6e-3
Ampex ATR-102 (classic Ampex 456): k=0.47, alpha=1.8e-3
MCI JH-24 (multitrack, various stocks): k=0.50, alpha=1.5e-3

---

## 8. Oversampler Memory Allocation — LOW (but affects reliability)

**File:** `src/dsp/oversampling.ts`

### Problem

`upsample()` and `downsample()` each allocate 2-3 `Float32Array` objects per
call. In the tape processor, these are called once per sample per channel in
the hot loop (128 samples × 2 channels = 256 calls per block). That's 512-768
allocations per ~2.7ms audio block.

In an AudioWorklet, garbage collection pauses cause audio glitches (clicks,
dropouts). The Web Audio spec strongly advises against allocation in the
`process()` callback.

### Recommended Fix

Pre-allocate all scratch buffers in the constructor:

```typescript
class Oversampler {
  private upsampleScratch: Float32Array;   // length: maxInputLen * factor
  private downsampleScratch: Float32Array;  // length: maxInputLen * factor
  private downsampleOutput: Float32Array;   // length: maxInputLen

  constructor(factor: number, maxInputLength = 1) {
    // ... existing kernel setup ...
    this.upsampleScratch = new Float32Array(maxInputLength * factor);
    this.downsampleScratch = new Float32Array(maxInputLength * factor);
    this.downsampleOutput = new Float32Array(maxInputLength);
  }
}
```

Since we process one sample at a time (`singleSample` of length 1 in the
tape processor), `maxInputLength = 1` is sufficient.

Also pre-allocate the `singleSample` buffer in the tape processor constructor
rather than in `process()`.

---

## 9. Transformer Model Refinements — MEDIUM

**File:** `src/dsp/transformer.ts`

### Missing: Eddy Current Losses

Real transformer cores have eddy current losses that cause frequency-dependent
losses proportional to f². These contribute to the "warmth" (HF loss) that
transformers add. Currently, only the LPF models HF rolloff, but eddy currents
add a different character — a smooth, progressive HF attenuation that starts
lower and increases gradually, unlike the resonant LPF rolloff.

Could be approximated by adding a gentle first-order lowpass (fc around
30-50 kHz) before the resonant LPF.

### Missing: Hysteresis in Core

The design doc notes the core uses `tanh` (memoryless). Real transformer
cores have a (small) hysteresis loop that contributes subtle distortion,
different from tape hysteresis. This is lower priority — the tanh approximation
is adequate for transformer cores since they operate far from saturation in
normal use.

### Asymmetry Term

The even-harmonic asymmetry term `0.015 * phi / (1 + phi²)` has a hardcoded
coefficient. This could be made per-preset — some transformers (especially
vintage ones with DC magnetization from aged capacitors) have more asymmetry.

---

## 10. Amplifier Model Verification — GOOD

**File:** `src/dsp/amplifier.ts`

### State-Space Matrices: VERIFIED CORRECT

I traced through the full DK-method derivation:

1. Trapezoidal companion models for Cc_in, Cc_out, Ck → Rc1, Rc2, Rc3 ✓
2. KCL at grid node (V1) → a1, b1, c1 coefficients ✓
3. KCL at plate node (V2) → a2, b2, c2 coefficients ✓
4. KCL at cathode node (V3) → a3, b3 coefficients ✓
5. Output node V4 = rl_frac × (V2 - x2) ✓
6. Port voltage equations Vpk, Vgk → Hd, Kd, Ld matrices ✓
7. State update equations → Ad, Bd, Cd matrices ✓
8. Output equation → Dd, Ed_vpp, Fd ✓

The Newton-Raphson solver and DC operating point initialization are also
correct. The Cohen-Helie tube equations match the published parameters.

### Minor Improvement: Miller Capacitance

Real 12AX7 tubes have plate-to-grid capacitance (~1.7 pF) that gets amplified
by the voltage gain (Miller effect), creating an effective input capacitance
of ~50-100 pF. This causes a gentle HF rolloff that contributes to the
"warm" tube sound. Adding a 4th state variable for Miller capacitance would
require expanding the state-space to 4×4, but would capture this important
tonal characteristic.

This is a significant enhancement but requires rederiving all the matrices.

---

## 11. Design Doc Deviations — LOW

### Oversampling Scope (IMPROVEMENT over spec)

The design doc says "Only hysteresis stage runs at oversampled rate." The
implementation wraps record amp + record EQ + bias + hysteresis in the
oversampled section. This is **better** than the spec — the amplifier's
nonlinearity also needs oversampling to prevent aliasing.

### Missing Mix (Dry/Wet) Parameter

The design doc specifies a "Mix" parameter (0-100%, default 100%) but no
mix control exists in the implementation. This is a useful feature for
parallel processing workflows.

### UI Technology

The design doc specifies "Vanilla DOM (no framework)" but the implementation
uses React + Zustand + @xyflow/react. This is fine — the UI choice doesn't
affect physical accuracy.

---

## Summary: Recommended Implementation Order

For maximum physical accuracy improvement per unit of effort:

### Phase 1: Core Accuracy (biggest sonic impact)

1. **Replace AC bias with parametric model** — Map bias knob to hysteresis `c`
   parameter. Remove bias oscillator from signal chain. (~1 day)

2. **FIR-based head loss filter** — Implement sinc gap loss + exponential
   spacing loss as a short FIR. Per-preset gap/spacing values. (~1-2 days)

3. **First-order EQ curves** — Replace 2nd-order shelf filters with proper
   1st-order shelves derived directly from time constants. (~0.5 day)

### Phase 2: Realism Enhancements

4. **Complex wow/flutter** — Add filtered noise components alongside the
   sine oscillators. Add wow frequency drift. (~1 day)

5. **Signal-dependent noise** — Add modulation noise component that scales
   with input signal level. Improve spectral shaping. (~0.5 day)

6. **Sag parameter alignment** — Update R_OUT and C1 to design doc values.
   (~15 minutes)

7. **Per-preset hysteresis parameters** — Add k, c_base, alpha to presets
   for different tape formulations. (~0.5 day)

### Phase 3: Refinements

8. **Pre-allocate oversampler buffers** — Eliminate GC pressure. (~30 minutes)

9. **Transformer eddy currents** — Add first-order LPF for core losses. (~30 min)

10. **Dry/wet mix** — Add missing mix parameter. (~30 minutes)

11. **Miller capacitance** — Add 4th state variable to tube model. (~1-2 days,
    requires matrix rederivation)
