# Amplifier Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the static tanh tube waveshaper with a Nodal DK-Method circuit simulation using Cohen-Helie 12AX7 equations and power supply sag.

**Architecture:** Single common-cathode triode stage modeled as a 3-state-variable nonlinear state-space system (DK-method). Trapezoidal discretization, Newton-Raphson per-sample solver. Power supply sag via 2 forward-Euler ODEs. Transistor mode unchanged.

**Tech Stack:** TypeScript, Vitest, AudioWorklet (48kHz)

**Design doc:** `docs/plans/2026-03-01-amplifier-model-design.md`

---

### Task 1: Cohen-Helie Tube Model Functions

**Files:**
- Create: `src/dsp/__tests__/amplifier.test.ts` (replace existing tests)
- Modify: `src/dsp/amplifier.ts`

**Step 1: Write failing tests for Cohen-Helie equations**

Add new test block to `src/dsp/__tests__/amplifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cohenHelieIk, cohenHelieIg, cohenHelieJacobian } from '../amplifier';

describe('Cohen-Helie 12AX7 tube model', () => {
  // Parameters from Cohen & Helie (DAFx 2010), fitted to 12AX7 measurements
  // Gk=2.14e-3, mu=100.8, Ek=1.303, Ck=3.04, Gg=6.06e-4, Eg=1.354, Cg=13.9

  describe('cohenHelieIk (cathode current)', () => {
    it('returns zero when tube is in cutoff (large negative Vgk)', () => {
      // With Vgk = -50V and Vpk = 250V: (250/100.8 + (-50)) is very negative
      // log(1 + exp(very_negative)) ≈ 0, so Ik ≈ 0
      const Ik = cohenHelieIk(250, -50);
      expect(Ik).toBeCloseTo(0, 6);
    });

    it('returns positive current in normal operating range', () => {
      // Typical 12AX7 operating point: Vgk ≈ -1.5V, Vpk ≈ 150V
      const Ik = cohenHelieIk(150, -1.5);
      expect(Ik).toBeGreaterThan(0);
      // 12AX7 typical plate current is 0.5-1.5 mA
      expect(Ik).toBeGreaterThan(0.0001);
      expect(Ik).toBeLessThan(0.01);
    });

    it('increases with less negative Vgk (more grid drive)', () => {
      const Ik_low = cohenHelieIk(200, -2.0);
      const Ik_high = cohenHelieIk(200, -0.5);
      expect(Ik_high).toBeGreaterThan(Ik_low);
    });

    it('is always non-negative', () => {
      const testCases = [
        [250, -5], [250, 0], [250, 5], [100, -2], [300, -1],
      ];
      for (const [Vpk, Vgk] of testCases) {
        expect(cohenHelieIk(Vpk, Vgk)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('cohenHelieIg (grid current)', () => {
    it('is near zero for negative Vgk (normal operation)', () => {
      // Grid current only flows when Vgk > 0 (grid conduction)
      const Ig = cohenHelieIg(-1.5);
      expect(Ig).toBeCloseTo(0, 5);
    });

    it('is positive for positive Vgk (grid conduction)', () => {
      const Ig = cohenHelieIg(5.0);
      expect(Ig).toBeGreaterThan(0);
    });

    it('increases with increasing Vgk', () => {
      const Ig_low = cohenHelieIg(1.0);
      const Ig_high = cohenHelieIg(5.0);
      expect(Ig_high).toBeGreaterThan(Ig_low);
    });

    it('is always non-negative', () => {
      for (const Vgk of [-10, -5, -2, -1, 0, 1, 5, 10]) {
        expect(cohenHelieIg(Vgk)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('cohenHelieJacobian', () => {
    it('returns a 2x2 matrix of partial derivatives', () => {
      const J = cohenHelieJacobian(200, -1.5);
      // J = [[dIp/dVpk, dIp/dVgk], [dIg/dVpk, dIg/dVgk]]
      expect(J).toHaveLength(4); // flat [j00, j01, j10, j11]
    });

    it('dIg/dVpk is zero (grid current independent of plate voltage)', () => {
      const J = cohenHelieJacobian(200, -1.5);
      expect(J[2]).toBe(0); // j10 = dIg/dVpk
    });

    it('matches numerical derivatives', () => {
      const Vpk = 180, Vgk = -1.2;
      const eps = 1e-5;
      const J = cohenHelieJacobian(Vpk, Vgk);

      // Numerical dIp/dVpk
      const Ip_hi = cohenHelieIk(Vpk + eps, Vgk) - cohenHelieIg(Vgk);
      const Ip_lo = cohenHelieIk(Vpk - eps, Vgk) - cohenHelieIg(Vgk);
      const dIp_dVpk_num = (Ip_hi - Ip_lo) / (2 * eps);
      expect(J[0]).toBeCloseTo(dIp_dVpk_num, 4);

      // Numerical dIp/dVgk
      const Ip_hi2 = cohenHelieIk(Vpk, Vgk + eps) - cohenHelieIg(Vgk + eps);
      const Ip_lo2 = cohenHelieIk(Vpk, Vgk - eps) - cohenHelieIg(Vgk - eps);
      const dIp_dVgk_num = (Ip_hi2 - Ip_lo2) / (2 * eps);
      expect(J[1]).toBeCloseTo(dIp_dVgk_num, 4);

      // Numerical dIg/dVgk
      const Ig_hi = cohenHelieIg(Vgk + eps);
      const Ig_lo = cohenHelieIg(Vgk - eps);
      const dIg_dVgk_num = (Ig_hi - Ig_lo) / (2 * eps);
      expect(J[3]).toBeCloseTo(dIg_dVgk_num, 4);
    });
  });

  describe('plate current (Ip = Ik - Ig)', () => {
    it('plate current equals cathode minus grid current', () => {
      const Vpk = 200, Vgk = -1.0;
      const Ik = cohenHelieIk(Vpk, Vgk);
      const Ig = cohenHelieIg(Vgk);
      const Ip = Ik - Ig;
      expect(Ip).toBeCloseTo(Ik, 6); // Ig ≈ 0 for negative Vgk
      expect(Ip).toBeGreaterThan(0);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dsp/__tests__/amplifier.test.ts`
Expected: FAIL — `cohenHelieIk`, `cohenHelieIg`, `cohenHelieJacobian` not exported

**Step 3: Implement Cohen-Helie functions**

Add to `src/dsp/amplifier.ts` (exported for testing):

```typescript
// Cohen-Helie 12AX7 parameters (DAFx 2010, fitted to measurements)
const CH_Gk = 2.14e-3;     // cathode current scaling
const CH_mu = 100.8;        // amplification factor
const CH_Ek = 1.303;        // cathode current exponent
const CH_Ck = 3.04;         // cathode transition smoothness
const CH_Gg = 6.06e-4;      // grid current scaling
const CH_Eg = 1.354;        // grid current exponent
const CH_Cg = 13.9;         // grid transition smoothness

/** Soft-plus: log(1 + exp(x)) with overflow protection. */
function softplus(x: number): number {
  if (x > 30) return x;           // exp(30) overflows float64 precision
  if (x < -30) return 0;
  return Math.log(1 + Math.exp(x));
}

/** Cohen-Helie cathode current Ik(Vpk, Vgk). */
export function cohenHelieIk(Vpk: number, Vgk: number): number {
  const arg = CH_Ck * (Vpk / CH_mu + Vgk);
  return CH_Gk * Math.pow(softplus(arg) / CH_Ck, CH_Ek);
}

/** Cohen-Helie grid current Ig(Vgk). */
export function cohenHelieIg(Vgk: number): number {
  const arg = CH_Cg * Vgk;
  return CH_Gg * Math.pow(softplus(arg) / CH_Cg, CH_Eg);
}

/**
 * Analytical Jacobian of [Ip, Ig] w.r.t. [Vpk, Vgk].
 * Returns flat array [dIp/dVpk, dIp/dVgk, dIg/dVpk, dIg/dVgk].
 */
export function cohenHelieJacobian(Vpk: number, Vgk: number): number[] {
  // dIk/dVpk
  const argK = CH_Ck * (Vpk / CH_mu + Vgk);
  const spK = softplus(argK);
  const sigK = 1 / (1 + Math.exp(-argK)); // sigmoid = d(softplus)/dx
  const baseK = spK / CH_Ck;
  const dIk_dargK = CH_Gk * CH_Ek * Math.pow(baseK, CH_Ek - 1) * sigK / CH_Ck;
  const dIk_dVpk = dIk_dargK * CH_Ck / CH_mu;
  const dIk_dVgk = dIk_dargK * CH_Ck;

  // dIg/dVgk
  const argG = CH_Cg * Vgk;
  const spG = softplus(argG);
  const sigG = 1 / (1 + Math.exp(-argG));
  const baseG = spG / CH_Cg;
  const dIg_dVgk = CH_Gg * CH_Eg * Math.pow(baseG, CH_Eg - 1) * sigG / CH_Cg * CH_Cg;

  // Ip = Ik - Ig
  return [
    dIk_dVpk,              // dIp/dVpk (Ig independent of Vpk)
    dIk_dVgk - dIg_dVgk,   // dIp/dVgk
    0,                      // dIg/dVpk
    dIg_dVgk,              // dIg/dVgk
  ];
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dsp/__tests__/amplifier.test.ts`
Expected: All Cohen-Helie tests PASS

**Step 5: Commit**

```bash
git add src/dsp/amplifier.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: add Cohen-Helie 12AX7 tube model equations with analytical Jacobian"
```

---

### Task 2: Circuit Component Types and Presets

**Files:**
- Modify: `src/dsp/amplifier.ts`
- Modify: `src/dsp/presets.ts`

**Step 1: Write failing test for circuit preset loading**

Add to `src/dsp/__tests__/amplifier.test.ts`:

```typescript
import { AmplifierModel } from '../amplifier';
import type { TubeCircuitParams } from '../amplifier';

describe('AmplifierModel tube circuit', () => {
  it('accepts circuit parameters and initializes without error', () => {
    const params: TubeCircuitParams = {
      Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
      Cc_in: 22e-9, Cc_out: 100e-9, Ck: 25e-6,
      Vpp: 250,
    };
    const amp = new AmplifierModel('tube', 1.0, params);
    expect(amp).toBeDefined();
  });

  it('defaults to Studer-like params when none provided', () => {
    const amp = new AmplifierModel('tube', 1.0);
    // Should not throw — uses default circuit params
    const out = amp.process(0.1);
    expect(Number.isFinite(out)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/dsp/__tests__/amplifier.test.ts`
Expected: FAIL — `TubeCircuitParams` not exported

**Step 3: Add TubeCircuitParams interface and update constructor**

In `src/dsp/amplifier.ts`, add the interface and update the constructor to accept optional circuit params:

```typescript
export interface TubeCircuitParams {
  Rp: number;      // plate load resistor (ohms)
  Rg: number;      // grid leak resistor (ohms)
  Rk: number;      // cathode resistor (ohms)
  Cc_in: number;   // input coupling cap (farads)
  Cc_out: number;  // output coupling cap (farads)
  Ck: number;      // cathode bypass cap (farads)
  Vpp: number;     // plate supply voltage (volts)
}

const DEFAULT_CIRCUIT: TubeCircuitParams = {
  Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
  Cc_in: 22e-9, Cc_out: 100e-9, Ck: 25e-6,
  Vpp: 250,
};
```

Update `AmplifierModel` constructor to accept `TubeCircuitParams` as optional third parameter. Store it as `this.circuitParams`.

**Step 4: Add circuit params to presets**

In `src/dsp/presets.ts`, add `tubeCircuit` field to `MachinePreset` and each preset:

```typescript
// Add to MachinePreset interface:
tubeCircuit?: TubeCircuitParams;

// studer preset:
tubeCircuit: {
  Rp: 100e3, Rg: 1e6, Rk: 1.5e3,
  Cc_in: 22e-9, Cc_out: 100e-9, Ck: 25e-6, Vpp: 250,
},

// ampex preset:
tubeCircuit: {
  Rp: 220e3, Rg: 470e3, Rk: 1.8e3,
  Cc_in: 47e-9, Cc_out: 220e-9, Ck: 22e-6, Vpp: 300,
},

// mci preset: no tubeCircuit (transistor mode)
```

**Step 5: Run tests, commit**

Run: `npx vitest run src/dsp/__tests__/amplifier.test.ts`
Expected: PASS

```bash
git add src/dsp/amplifier.ts src/dsp/presets.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: add tube circuit component types and per-machine presets"
```

---

### Task 3: State-Space Matrix Derivation (DK-Method Core)

This is the mathematical heart. The MNA matrices encode the circuit topology.

**Files:**
- Modify: `src/dsp/amplifier.ts`
- Modify: `src/dsp/__tests__/amplifier.test.ts`

**Step 1: Write failing tests for matrix computation**

```typescript
describe('DK-method state-space matrices', () => {
  it('computes discretized matrices from circuit params', () => {
    const amp = new AmplifierModel('tube', 1.0);
    // The model should have precomputed matrices internally
    // We test indirectly: processing a sample should use the state-space system
    const out = amp.process(0);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('DC operating point: zero input produces near-zero AC output', () => {
    const amp = new AmplifierModel('tube', 1.0);
    // After initialization, the DC operating point is set.
    // Processing zero input should produce near-zero output
    // (the output coupling cap blocks the DC plate voltage).
    let lastOut = 0;
    for (let i = 0; i < 1000; i++) {
      lastOut = amp.process(0);
    }
    expect(Math.abs(lastOut)).toBeLessThan(0.01);
  });

  it('state-space produces non-zero output for non-zero input', () => {
    const amp = new AmplifierModel('tube', 1.0);
    // Feed a 440Hz sine for 0.1s, check output is non-zero
    const fs = 48000;
    let maxOut = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    expect(maxOut).toBeGreaterThan(0.001);
  });
});
```

**Step 2: Run tests to verify they fail**

Expected: FAIL (process still uses old tanh model, or new state-space not wired)

**Step 3: Implement the DK-method matrix derivation**

In `src/dsp/amplifier.ts`, add a private method `initStateSpace(params, sampleRate)` that:

1. Constructs the continuous-time MNA matrices from the circuit topology.
   The circuit has 5 nodes (input, grid, plate, cathode, output) and 3 energy-storage elements (capacitors).

2. The nodal equations (KCL at each node) produce the continuous-time system. For the common-cathode stage:

   **Node: grid** — Current through Cc_in + current through Rg + grid current Ig = 0
   **Node: plate** — Current through Rp + plate current Ip + current through Cc_out = 0
   **Node: cathode** — Current through Rk + current through Ck - cathode current Ik = 0
   **Node: output** — Current through Cc_out = output (into load)

3. State variables: x = [V_Cc_in, V_Cc_out, V_Ck]
   Nonlinear ports: i_nl = [Ip, Ig], v_nl = [Vpk, Vgk]

4. Apply trapezoidal discretization to get discrete matrices Ad, Bd, Cd, Dd, Ed, Fd, Hd, Kd, Ld.

5. Store these as private fields (Float64Arrays for the small matrices, or just number arrays since they're 3x3 at most).

The actual matrix derivation requires careful algebra from the circuit. The key insight is that for this specific topology, the matrices can be written in closed form (no need for a general MNA solver). The implementation should include:

```typescript
private initStateSpace(params: TubeCircuitParams, fs: number): void {
  const T = 1 / fs;
  const { Rp, Rg, Rk, Cc_in, Cc_out, Ck, Vpp } = params;

  // Companion resistances (trapezoidal rule)
  const Rc_in = T / (2 * Cc_in);
  const Rc_out = T / (2 * Cc_out);
  const Rc_k = T / (2 * Ck);

  // Build the conductance matrix G for the resistive companion circuit.
  // After trapezoidal substitution, each capacitor becomes a resistor Rc
  // in series with a history voltage source.
  //
  // The circuit reduces to a resistive network with voltage sources
  // (history terms) and nonlinear elements (triode).
  //
  // Solve the resistive network symbolically to get:
  //   v_nl = Hd * x + Kd * u + Ld * i_nl
  //   x_next = Ad * x + Bd * u + Cd * i_nl
  //   y = Dd * x + Ed * u + Fd * i_nl
  //
  // Store all matrices as private fields.

  // ... (detailed matrix algebra — see design doc for equations)
  // The matrices depend only on R, C values and T — precomputed once.
}
```

**Step 4: Implement DC operating point solver**

```typescript
private solveDCOperatingPoint(): void {
  const { Rp, Rk, Vpp } = this.circuitParams;

  // At DC: capacitors are open circuits
  // Grid is at ground through Rg (Vg = 0)
  // Iteratively solve for Vk (cathode voltage):
  //   Vgk = -Vk
  //   Vpk = Vpp - Ip*Rp - Vk
  //   Ip = Ik(Vpk, Vgk) - Ig(Vgk)
  //   Vk = (Ip + Ig) * Rk  (total cathode current * Rk)

  let Vk = 1.0; // initial guess
  for (let iter = 0; iter < 20; iter++) {
    const Vgk = -Vk;
    const Ik = cohenHelieIk(this.circuitParams.Vpp - Rp * (cohenHelieIk(this.circuitParams.Vpp, Vgk) - cohenHelieIg(Vgk)) - Vk, Vgk);
    // Simplified: solve self-consistently
    const Ig = cohenHelieIg(Vgk);
    const Ip = Ik - Ig;
    const Ik_total = Ip + Ig; // = Ik
    const Vk_new = Ik_total * Rk;
    if (Math.abs(Vk_new - Vk) < 1e-6) break;
    Vk = Vk_new;
  }

  // Initialize state: x = [V_Cc_in, V_Cc_out, V_Ck]
  const Vgk = -Vk;
  const Ig = cohenHelieIg(Vgk);
  const Ip_dc = cohenHelieIk(Vpp - (cohenHelieIk(Vpp, Vgk) - Ig) * Rp - Vk, Vgk) - Ig;
  const Vp = Vpp - Ip_dc * Rp;

  this.x = [0, Vp, Vk]; // Cc_in=0, Cc_out=Vplate, Ck=Vcathode
  this.i_nl_prev = [Ip_dc, Ig];
  this.sagVpp = Vpp;
  this.sagVscreen = Vpp;
}
```

**Step 5: Wire tube mode process() to state-space solver**

Replace `tubeSaturate()` call with the Newton-Raphson state-space solver in `process()`.

**Step 6: Run tests, commit**

Run: `npx vitest run src/dsp/__tests__/amplifier.test.ts`
Expected: PASS

```bash
git add src/dsp/amplifier.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: implement DK-method state-space circuit simulation for tube mode"
```

---

### Task 4: Newton-Raphson Per-Sample Solver

**Files:**
- Modify: `src/dsp/amplifier.ts`
- Modify: `src/dsp/__tests__/amplifier.test.ts`

**Step 1: Write failing tests for Newton convergence**

```typescript
describe('Newton-Raphson solver', () => {
  it('converges within 8 iterations for normal signal levels', () => {
    const amp = new AmplifierModel('tube', 1.0);
    // Process a sine wave — should not produce NaN (convergence failure)
    const fs = 48000;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('handles extreme overdrive without NaN', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0); // max drive = 4.5x gain
    const fs = 48000;
    for (let i = 0; i < fs * 0.5; i++) {
      const x = 2.0 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('output is bounded (no runaway)', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;
    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const x = Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    expect(maxOut).toBeLessThan(10); // output should be reasonable
  });
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement Newton-Raphson solver**

```typescript
private newtonSolve(x: number[], u: number): { i_nl: number[]; y: number } {
  // Initial guess: previous sample's nonlinear currents
  let i_nl = [this.i_nl_prev[0], this.i_nl_prev[1]];

  for (let iter = 0; iter < 8; iter++) {
    // Compute tube port voltages from current state and i_nl guess
    // v_nl = Hd * x + Kd * u + Ld * i_nl
    const Vpk = this.Hd[0]*x[0] + this.Hd[1]*x[1] + this.Hd[2]*x[2]
              + this.Kd[0]*u
              + this.Ld[0]*i_nl[0] + this.Ld[1]*i_nl[1];
    const Vgk = this.Hd[3]*x[0] + this.Hd[4]*x[1] + this.Hd[5]*x[2]
              + this.Kd[1]*u
              + this.Ld[2]*i_nl[0] + this.Ld[3]*i_nl[1];

    // Evaluate tube model
    const Ik_eval = cohenHelieIk(Vpk, Vgk);
    const Ig_eval = cohenHelieIg(Vgk);
    const Ip_eval = Ik_eval - Ig_eval;
    const i_nl_eval = [Ip_eval, Ig_eval];

    // Residual
    const r0 = i_nl[0] - i_nl_eval[0];
    const r1 = i_nl[1] - i_nl_eval[1];

    if (Math.abs(r0) < 1e-9 && Math.abs(r1) < 1e-9) break;

    // Jacobian J = d(i_nl)/d(v_nl)
    const J = cohenHelieJacobian(Vpk, Vgk);

    // Newton matrix: M = I - J * Ld (2x2)
    // Solve M * delta = -residual
    const M00 = 1 - (J[0]*this.Ld[0] + J[1]*this.Ld[2]);
    const M01 = -(J[0]*this.Ld[1] + J[1]*this.Ld[3]);
    const M10 = -(J[2]*this.Ld[0] + J[3]*this.Ld[2]);
    const M11 = 1 - (J[2]*this.Ld[1] + J[3]*this.Ld[3]);

    const det = M00 * M11 - M01 * M10;
    if (Math.abs(det) < 1e-15) break;

    const d0 = -(M11 * r0 - M01 * r1) / det;
    const d1 = -(-M10 * r0 + M00 * r1) / det;

    i_nl[0] += d0;
    i_nl[1] += d1;
  }

  // Compute output and next state
  // x_next = Ad * x + Bd * u + Cd * i_nl
  // y = Dd * x + Ed * u + Fd * i_nl
  const y = this.Dd[0]*x[0] + this.Dd[1]*x[1] + this.Dd[2]*x[2]
          + this.Ed[0]*u
          + this.Fd[0]*i_nl[0] + this.Fd[1]*i_nl[1];

  return { i_nl, y };
}
```

**Step 4: Run tests, commit**

Run: `npx vitest run src/dsp/__tests__/amplifier.test.ts`
Expected: PASS

```bash
git add src/dsp/amplifier.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: implement Newton-Raphson per-sample solver for tube circuit"
```

---

### Task 5: Power Supply Sag Model

**Files:**
- Modify: `src/dsp/amplifier.ts`
- Modify: `src/dsp/__tests__/amplifier.test.ts`

**Step 1: Write failing tests**

```typescript
describe('power supply sag', () => {
  it('Vpp sags under sustained heavy signal', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;

    // Process 0.5s of loud sine to drain the supply
    for (let i = 0; i < fs * 0.5; i++) {
      const x = 1.5 * Math.sin(2 * Math.PI * 100 * i / fs);
      amp.process(x);
    }

    // The output level should be lower than at the start
    // because the supply has sagged, reducing headroom.
    // Measure peak output for next 100ms
    let peakLate = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      const x = 1.5 * Math.sin(2 * Math.PI * 100 * i / fs);
      const y = amp.process(x);
      peakLate = Math.max(peakLate, Math.abs(y));
    }

    // Reset and measure fresh peak
    amp.reset();
    let peakFresh = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      const x = 1.5 * Math.sin(2 * Math.PI * 100 * i / fs);
      const y = amp.process(x);
      peakFresh = Math.max(peakFresh, Math.abs(y));
    }

    // Sagged output should be noticeably less than fresh
    expect(peakLate).toBeLessThan(peakFresh * 0.98);
  });

  it('supply recovers after signal stops', () => {
    const amp = new AmplifierModel('tube', 1.0);
    amp.setDrive(1.0);
    const fs = 48000;

    // Heavy signal for 0.5s
    for (let i = 0; i < fs * 0.5; i++) {
      amp.process(1.5 * Math.sin(2 * Math.PI * 100 * i / fs));
    }

    // Silence for 1s (supply recovers)
    for (let i = 0; i < fs; i++) {
      amp.process(0);
    }

    // Measure output — should be close to fresh
    let peakRecovered = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      const x = 1.5 * Math.sin(2 * Math.PI * 100 * i / fs);
      const y = amp.process(x);
      peakRecovered = Math.max(peakRecovered, Math.abs(y));
    }

    amp.reset();
    let peakFresh = 0;
    for (let i = 0; i < fs * 0.1; i++) {
      const x = 1.5 * Math.sin(2 * Math.PI * 100 * i / fs);
      const y = amp.process(x);
      peakFresh = Math.max(peakFresh, Math.abs(y));
    }

    // Recovered peak should be within 5% of fresh
    expect(peakRecovered).toBeGreaterThan(peakFresh * 0.95);
  });
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement sag model**

Add to `AmplifierModel`:

```typescript
// Sag model state
private sagVpp: number;
private sagVscreen: number;

// Sag parameters
private static readonly SAG_R_OUT = 600;       // supply output impedance
private static readonly SAG_R_FILTER = 4700;    // inter-stage filter R
private static readonly SAG_C1 = 47e-6;         // first filter cap
private static readonly SAG_C2 = 22e-6;         // second filter cap
private static readonly SAG_R_BLEEDER = 220e3;  // bleeder resistor

private updateSag(Ip: number, T: number): void {
  const Vpp = this.sagVpp;
  const Vss = this.sagVscreen;
  const Videal = this.circuitParams.Vpp;
  const Isupply = Videal / AmplifierModel.SAG_R_OUT;

  const dVpp = (Isupply - Ip - (Vpp - Vss) / AmplifierModel.SAG_R_FILTER)
               / AmplifierModel.SAG_C1;
  const dVss = ((Vpp - Vss) / AmplifierModel.SAG_R_FILTER - Vss / AmplifierModel.SAG_R_BLEEDER)
               / AmplifierModel.SAG_C2;

  this.sagVpp = Vpp + T * dVpp;
  this.sagVscreen = Vss + T * dVss;
}
```

Wire `updateSag` into `process()` — call after Newton solve, feed `sagVpp` as the plate supply voltage into the next sample's Newton iteration.

**Step 4: Run tests, commit**

```bash
git add src/dsp/amplifier.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: add power supply sag model with forward-Euler integration"
```

---

### Task 6: Output Normalization and Drive Mapping

**Files:**
- Modify: `src/dsp/amplifier.ts`
- Modify: `src/dsp/__tests__/amplifier.test.ts`

**Step 1: Write failing tests**

```typescript
describe('output normalization and drive', () => {
  it('output is in approximately [-1, 1] range for normal input', () => {
    const amp = new AmplifierModel('tube', 0.5);
    const fs = 48000;
    let maxOut = 0;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      const y = amp.process(x);
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    // Should be in a reasonable range, not raw plate voltages
    expect(maxOut).toBeGreaterThan(0.05);
    expect(maxOut).toBeLessThan(2.0);
  });

  it('higher drive produces more saturation (less linear)', () => {
    const fs = 48000;

    // Low drive
    const ampLow = new AmplifierModel('tube', 0.2);
    let maxLow = 0;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      maxLow = Math.max(maxLow, Math.abs(ampLow.process(x)));
    }

    // High drive
    const ampHigh = new AmplifierModel('tube', 1.0);
    let maxHigh = 0;
    for (let i = 0; i < fs; i++) {
      const x = 0.5 * Math.sin(2 * Math.PI * 440 * i / fs);
      maxHigh = Math.max(maxHigh, Math.abs(ampHigh.process(x)));
    }

    // High drive should produce higher output (more gain into saturation)
    expect(maxHigh).toBeGreaterThan(maxLow);
  });

  it('tube mode produces asymmetric clipping (even harmonics)', () => {
    const amp = new AmplifierModel('tube', 1.0);
    const fs = 48000;

    // Process 1s of sine, skip transient
    const outputs: number[] = [];
    for (let i = 0; i < fs; i++) {
      const x = 0.8 * Math.sin(2 * Math.PI * 440 * i / fs);
      outputs.push(amp.process(x));
    }

    // Check asymmetry: positive and negative peaks should differ
    const posPeak = Math.max(...outputs.slice(fs * 0.5));
    const negPeak = Math.min(...outputs.slice(fs * 0.5));
    expect(Math.abs(posPeak)).not.toBeCloseTo(Math.abs(negPeak), 1);
  });
});
```

**Step 2: Implement output normalization**

The state-space output is in volts (plate voltage swing). Normalize by dividing by the DC plate voltage so output is in roughly [-1, 1]:

```typescript
// In process(), after Newton solve:
const y_normalized = result.y / this.dcPlateVoltage;
```

Map drive parameter:
```typescript
setDrive(v: number): void {
  this.drive = 0.5 + v * 4.0; // 0→0.5x, 1→4.5x input gain
}
```

**Step 3: Run tests, commit**

```bash
git add src/dsp/amplifier.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: add output normalization and drive mapping for tube circuit"
```

---

### Task 7: Integration with Tape Processor and Presets

**Files:**
- Modify: `src/worklet/tape-processor.ts` (minimal — pass circuit params)
- Modify: `src/dsp/presets.ts` (already done in Task 2)
- Modify: `src/dsp/__tests__/amplifier.test.ts`

**Step 1: Write integration tests**

```typescript
describe('backward compatibility', () => {
  it('transistor mode is unchanged', () => {
    const amp = new AmplifierModel('transistor', 2.0);
    const outPos = amp.process(0.8);
    const outNeg = amp.process(-0.8);
    expect(Math.abs(outPos)).toBeCloseTo(Math.abs(outNeg), 2);
  });

  it('reset clears state and does not throw', () => {
    const amp = new AmplifierModel('tube', 1.0);
    for (let i = 0; i < 100; i++) {
      amp.process(Math.sin(i * 0.1));
    }
    expect(() => amp.reset()).not.toThrow();
    // After reset, zero input should give near-zero output
    for (let i = 0; i < 100; i++) {
      amp.process(0);
    }
    expect(Math.abs(amp.process(0))).toBeLessThan(0.01);
  });
});
```

**Step 2: Update tape-processor.ts**

Pass circuit params from preset to AmplifierModel constructor:

```typescript
// In initDSP():
const recordAmp = new AmplifierModel(preset.ampType, 1.0, preset.tubeCircuit);
const playbackAmp = new AmplifierModel(preset.ampType, 0.8, preset.tubeCircuit);
```

This is a one-line change per amp instance. The `AmplifierModel` constructor already handles `undefined` circuit params (defaults to Studer values).

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All 35+ tests PASS

**Step 4: Commit**

```bash
git add src/worklet/tape-processor.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: wire tube circuit params from presets to amplifier model"
```

---

### Task 8: Final Verification

**Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS, no regressions

**Step 2: Run build**

Run: `npm run build`
Expected: Clean build, no TypeScript errors

**Step 3: Manual smoke test**

Run: `npm run dev`
- Load an audio file
- Switch between machines (Studer, Ampex, MCI)
- Sweep drive from 0 to 1 — should hear increasing saturation with tube character
- Listen for: warmth, compression, frequency-dependent distortion
- Verify no clicks, pops, or silence

**Step 4: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "feat: complete tube amplifier circuit simulation (DK-method + Cohen-Helie + sag)"
```
