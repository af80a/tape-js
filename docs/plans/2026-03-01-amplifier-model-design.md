# Amplifier Model Redesign: Physically-Accurate Tube Stage via Nodal DK-Method

## Goal

Replace the current static `tanh` waveshaper tube model with a physically-accurate
circuit simulation of a single common-cathode 12AX7 triode gain stage, using the
Nodal DK-Method (state-space circuit simulation) with Cohen-Helie tube equations and
power supply sag modeling.

## Why

The current model (`Math.tanh(x + bias)`) is a memoryless nonlinearity. It captures
the rough shape of tube clipping but misses:

- Frequency-dependent distortion (coupling caps interact with the nonlinearity)
- Dynamic bias shift (cathode bypass capacitor charges under signal)
- Grid conduction and blocking distortion under overdrive
- Power supply sag (signal-dependent compression)
- Proper harmonic spectrum (even-order dominance with natural rolloff)

These are the phenomena that make tubes sound like tubes.

## Approach: Nodal DK-Method

The DK-method (Yeh, Smith — Stanford CCRMA, 2009) derives a nonlinear state-space
model directly from a circuit schematic via Modified Nodal Analysis, then discretizes
with the trapezoidal rule. Nonlinearities are solved per-sample with Newton-Raphson.

### References

- Yeh, "Digital Implementation of Musical Distortion Circuits" (Stanford PhD, 2009)
- Cohen & Helie, "Measures and models of real triodes" (DAFx, 2010)
- Dempwolf & Zolzer, "A Physically-Motivated Triode Model" (DAFx, 2011)
- Pakarinen & Yeh, "A Review of Digital Techniques for Modeling Vacuum-Tube Guitar Amplifiers" (CMJ, 2009)
- AmpBooks, "Digital Modeling of a Guitar Amplifier Power Supply"

## Circuit Topology

Single common-cathode triode gain stage — the fundamental building block of tape
machine record/playback electronics.

```
         Vpp (plate supply, from sag model)
          |
         [Rp]  plate load resistor
          |
    +-----+ plate
    |     |
    |   (12AX7 triode)
    |     |
    |     + grid ---[Rg]--[Cc_in]--- Input
    |     |
    |     | cathode
    |     |
    |    [Rk]--+--- GND
    |          [Ck]
    |           |
    |          GND
    |
    +--[Cc_out]--- Output
```

### Components

- **Cc_in** (input coupling capacitor): Blocks DC, sets low-frequency rolloff into the grid.
- **Rg** (grid leak resistor): Sets grid bias point, provides DC path to ground.
- **Rp** (plate load resistor): Converts plate current to voltage gain.
- **Rk** (cathode resistor): Self-bias — sets the DC operating point.
- **Ck** (cathode bypass capacitor): Bypasses Rk at audio frequencies, increasing gain.
  At very low frequencies, Ck is effectively open and Rk provides negative feedback,
  reducing gain. This frequency-dependent gain is a key tonal characteristic.
- **Cc_out** (output coupling capacitor): Blocks DC from the plate, passes AC signal.
- **Vpp** (plate supply voltage): Fed from the power supply sag model.

### State Variables

Three capacitors = three state variables:
- `V_Cc_in` — voltage across input coupling cap
- `V_Cc_out` — voltage across output coupling cap
- `V_Ck` — voltage across cathode bypass cap

### Per-Machine Component Values

| Component | Studer A810 | Ampex ATR-102 | MCI JH-24 (tube) |
|-----------|-------------|---------------|-------------------|
| Rp        | 100 kΩ      | 220 kΩ        | 100 kΩ            |
| Rg        | 1 MΩ        | 470 kΩ        | 1 MΩ              |
| Rk        | 1.5 kΩ      | 1.8 kΩ        | 1.5 kΩ            |
| Cc_in     | 22 nF       | 47 nF         | 100 nF            |
| Cc_out    | 100 nF      | 220 nF        | 100 nF            |
| Ck        | 25 µF       | 22 µF         | 47 µF             |
| Vpp       | 250 V       | 300 V         | 250 V             |

These values produce different tonal characters:
- Studer: Tighter LF rolloff (smaller Cc_in), cleaner headroom
- Ampex: Warmer (larger caps, higher plate voltage, higher gain from larger Rp)
- MCI: More mid-forward character

## Tube Model: Cohen-Helie 12AX7

Chosen for smooth (C-infinity) derivatives, which is critical for Newton-Raphson
convergence. Unlike the Koren model which uses `sgn()` and piecewise functions,
Cohen-Helie uses `log(1+exp(...))` throughout.

### Equations

Grid current:
```
Ig = Gg * (log(1 + exp(Cg * Vgk)) / Cg)^Eg
```

Cathode current:
```
Ik = Gk * (log(1 + exp(Ck_coeff * (Vpk/mu + Vgk))) / Ck_coeff)^Ek
```

Plate current:
```
Ip = Ik - Ig
```

### Parameters (fitted to real 12AX7 measurements)

| Parameter | Value   | Description                    |
|-----------|---------|--------------------------------|
| Gk        | 2.14e-3 | Cathode current scaling        |
| mu        | 100.8   | Amplification factor           |
| Ek        | 1.303   | Cathode current exponent       |
| Ck_coeff  | 3.04    | Cathode transition smoothness  |
| Gg        | 6.06e-4 | Grid current scaling           |
| Eg        | 1.354   | Grid current exponent          |
| Cg        | 13.9    | Grid transition smoothness     |

### What This Captures

- Plate current saturation and cutoff (smooth transition)
- Grid conduction with smooth onset (not a hard diode switch)
- Blocking distortion under heavy overdrive
- Current conservation at cathode node (Ip = Ik - Ig)
- Even-harmonic generation from asymmetric operation

## State-Space Formulation (DK-Method)

### Step 1: Modified Nodal Analysis

From the circuit, identify:
- Linear elements: Rp, Rg, Rk (resistors), Cc_in, Cc_out, Ck (capacitors)
- Nonlinear elements: Triode (2-port nonlinear: Ip and Ig as functions of Vpk, Vgk)
- Source: Input voltage

Construct the MNA system:
```
C_mat * dx/dt = A_mat * x + B_mat * u + D_mat * i_nl(v_nl)
y = E_mat * x + F_mat * u + G_mat * i_nl(v_nl)
v_nl = H_mat * x + K_mat * u
```

Where:
- x = [V_Cc_in, V_Cc_out, V_Ck]^T (state vector, 3 elements)
- u = [V_in] (input signal)
- i_nl = [Ip, Ig]^T (nonlinear tube currents)
- v_nl = [Vpk, Vgk]^T (tube port voltages)

### Step 2: Trapezoidal Discretization

Apply trapezoidal rule: s = (2/T) * (z-1)/(z+1)

This converts the continuous system to discrete:
```
x[n+1] = Ad * x[n] + Bd * u[n] + Cd * i_nl[n]
y[n]   = Dd * x[n] + Ed * u[n] + Fd * i_nl[n]
v_nl[n] = Hd * x[n] + Kd * u[n] + Ld * i_nl[n]
```

Matrices Ad, Bd, Cd, Dd, Ed, Fd, Hd, Kd, Ld are precomputed constants
(depend on component values and sample rate). Recomputed on preset change
or sample rate change.

### Step 3: Newton-Raphson Solver

The nonlinear currents depend on the tube port voltages, which depend on
the state, which depends on the nonlinear currents — creating an implicit loop.

Per sample:
1. Initial guess: i_nl = previous sample's solution
2. Compute v_nl from current state and i_nl guess
3. Evaluate Cohen-Helie: Ip(Vpk, Vgk), Ig(Vgk)
4. Compute Jacobian J = d(i_nl)/d(v_nl) analytically
5. Newton step: delta = -(I - J*Ld)^(-1) * (i_nl_guess - i_nl_eval)
6. Update: i_nl += delta
7. Check convergence: |delta| < 1e-6
8. Repeat (typically 2-4 iterations)

If Newton doesn't converge within 8 iterations, use the last estimate
(graceful degradation, not a hard failure).

### Step 4: State Update and Output

Once i_nl is solved:
```
x[n+1] = Ad * x[n] + Bd * u[n] + Cd * i_nl[n]
y[n]   = Dd * x[n] + Ed * u[n] + Fd * i_nl[n]
```

The output y[n] is the voltage at the output node (after Cc_out).

## Power Supply Sag Model

Two first-order ODEs model the B+ plate supply:

```
dVpp/dt = (I_supply - I_plate_total - (Vpp - Vscreen) / R_filter) / C_filter1
dVscreen/dt = ((Vpp - Vscreen) / R_filter - I_screen) / C_filter2
```

### Parameters

| Parameter    | Value    | Description                        |
|--------------|----------|------------------------------------|
| V_ideal      | 250-300V | Ideal rectified voltage (per preset) |
| R_out        | 500-1000Ω | Supply output impedance            |
| R_filter     | 4.7 kΩ   | Inter-stage filter resistor        |
| C_filter1    | 47 µF    | First filter capacitor             |
| C_filter2    | 22 µF    | Second filter capacitor            |
| R_bleeder    | 220 kΩ   | Bleeder resistor                   |

### Integration

Forward Euler (the dynamics are slow — time constants of 10-50ms — so Euler is
stable and accurate at 48kHz). The sagging Vpp feeds into the tube model as the
plate supply voltage, modifying Vpk and therefore the distortion character.

Under heavy signal, Vpp drops → less headroom → more compression → natural
"breathing" feel. Recovery is slow (capacitor recharge), creating the characteristic
sag envelope.

## DC Operating Point Initialization

On reset or preset change, the quiescent operating point must be computed.
This is the DC bias point with no input signal:

1. Set u = 0
2. Solve the DC circuit (capacitors are open circuits at DC):
   - Vgk = 0 (grid at ground through Rg, no signal)
   - Compute Ip at Vgk=0, Vpk=Vpp
   - Vk = Ip * Rk (cathode voltage from plate current through Rk)
   - Vgk = -Vk (grid is at ground, cathode is at Vk)
   - Iterate until Vgk converges (typically 3-5 iterations)
3. Initialize capacitor states:
   - V_Cc_in = 0 (no DC across input coupling cap)
   - V_Ck = Vk (cathode voltage)
   - V_Cc_out = Vp (plate voltage = Vpp - Ip*Rp)
4. Initialize sag model: Vpp = V_ideal, Vscreen = V_ideal

This eliminates startup transients.

## Transistor Mode

The existing transistor saturation model (symmetric hard-knee clipper) is retained
unchanged. It's appropriate for solid-state tape machine electronics (like the
MCI JH-24) and doesn't need the same level of physical modeling.

## Drive Parameter Mapping

The UI drive parameter (0-1) maps to input gain scaling applied before the
circuit simulation:

```
input_scaled = input * (0.5 + drive * 4.0)
```

This gives a range from gentle coloration (drive=0, 0.5x gain) to heavy
overdrive (drive=1, 4.5x gain). The circuit's natural saturation characteristics
handle the rest — no need for artificial clipping curves.

## Anti-Aliasing

No additional anti-aliasing beyond the existing 2x-4x oversampling in the signal
chain. The oversampler already wraps the entire record path including the amplifier.
The tube model's smooth Cohen-Helie equations produce less aliasing than hard
clippers, and the coupling capacitors act as natural anti-alias filters by rolling
off high frequencies before they reach the nonlinearity.

## API Compatibility

The public interface remains identical:

```typescript
class AmplifierModel {
  constructor(mode: 'tube' | 'transistor', drive?: number)
  setDrive(v: number): void
  process(input: number): number
  reset(): void
}
```

Internal changes:
- Constructor initializes state-space matrices and DC operating point (tube mode)
- `process()` runs Newton-Raphson solver (tube mode) or existing clipper (transistor)
- `reset()` now resets capacitor states and sag model (tube mode)

New internal methods:
- `initCircuit(preset)` — compute MNA matrices for given component values
- `solveDCOperatingPoint()` — find quiescent bias point
- `newtonSolve(x, u)` — per-sample Newton-Raphson iteration
- `updateSag(Ip)` — forward-Euler power supply update
- `cohenHelieIp(Vpk, Vgk)` — plate current
- `cohenHelieIg(Vgk)` — grid current
- `cohenHelieJacobian(Vpk, Vgk)` — analytical Jacobian for Newton

New constructor parameter or method needed:
- `setPreset(preset)` — updates component values and recomputes matrices

## File Structure

All code stays in `src/dsp/amplifier.ts`. No new files needed. The class grows
from ~80 lines to ~300-400 lines, which is appropriate for a circuit simulation.

## Performance Estimate

Per sample (tube mode):
- 1 matrix-vector multiply (3x3 state update)
- 2-4 Newton iterations, each: 2 Cohen-Helie evaluations + 2x2 Jacobian + 2x2 linear solve
- 1 forward-Euler sag update (2 additions)

Estimated: ~5-10x the cost of the current `tanh` model. At 48kHz stereo with
2x oversampling, this is ~960k samples/sec. Each sample costs roughly 50-100
floating-point operations. Total: ~50-100M FLOPS — well within a single CPU core.
