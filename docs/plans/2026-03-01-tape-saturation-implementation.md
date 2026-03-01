# Tape Saturation Plugin — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a physically modeled tape machine emulation as a standalone Web Audio app.

**Architecture:** AudioWorklet-based DSP engine with Jiles-Atherton hysteresis, transformer/amplifier modeling, NAB/IEC EQ, transport mechanics. Vanilla TS UI with Vite bundling.

**Tech Stack:** TypeScript, Vite, Vitest, Web Audio API (AudioWorklet)

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`, `tsconfig.app.json`, `tsconfig.worklet.json`
- Create: `vite.config.ts`
- Create: `public/index.html`
- Create: `src/vite-env.d.ts`
- Create: `vitest.config.ts`

**Step 1: Initialize project**

```bash
cd /Users/juan.decroche/tmp/plugin-claude
npm init -y
npm install -D typescript vite vitest @types/audioworklet
```

**Step 2: Create package.json scripts**

Update `package.json` scripts:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 3: Create tsconfig files**

`tsconfig.json` (root references):
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.worklet.json" }
  ]
}
```

`tsconfig.app.json` (main thread — DOM):
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/worklet/**/*.ts"]
}
```

`tsconfig.worklet.json` (worklet — no DOM):
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["audioworklet"]
  },
  "include": ["src/worklet/**/*.ts", "src/dsp/**/*.ts"]
}
```

**Step 4: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
});
```

**Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**Step 6: Create index.html**

`public/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tape Saturator</title>
  <link rel="stylesheet" href="/src/styles/main.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 7: Create src/vite-env.d.ts**

```typescript
/// <reference types="vite/client" />

declare module '*?worker&url' {
  const src: string;
  export default src;
}
```

**Step 8: Create placeholder main.ts and styles**

`src/main.ts`:
```typescript
console.log('Tape Saturator loading...');
```

`src/styles/main.css`:
```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1a1a2e; color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; }
```

**Step 9: Verify setup**

```bash
npx vite --open
npx vitest run
```
Expected: Dev server starts, no test files yet (0 tests).

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: scaffold project with Vite, TypeScript, Vitest"
```

---

### Task 2: Biquad Filter Utility

All DSP components need biquad filters (EQ, head bump, transformer response). Build this shared utility first.

**Files:**
- Create: `src/dsp/biquad.ts`
- Create: `src/dsp/__tests__/biquad.test.ts`

**Step 1: Write the failing test**

`src/dsp/__tests__/biquad.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { BiquadFilter, designLowpass, designPeaking, designHighpass } from '../biquad';

describe('BiquadFilter', () => {
  it('passes DC through a lowpass filter', () => {
    const coeffs = designLowpass(1000, 48000, 0.707);
    const filter = new BiquadFilter(coeffs);
    // Feed 100 samples of DC=1.0, output should converge to 1.0
    let out = 0;
    for (let i = 0; i < 100; i++) {
      out = filter.process(1.0);
    }
    expect(out).toBeCloseTo(1.0, 2);
  });

  it('attenuates signal above lowpass cutoff', () => {
    const fs = 48000;
    const fc = 1000;
    const coeffs = designLowpass(fc, fs, 0.707);
    const filter = new BiquadFilter(coeffs);
    // Generate a 10kHz sine (well above cutoff) and measure output amplitude
    const freq = 10000;
    let maxOut = 0;
    for (let i = 0; i < 4800; i++) {
      const input = Math.sin(2 * Math.PI * freq * i / fs);
      const out = Math.abs(filter.process(input));
      if (i > 480) maxOut = Math.max(maxOut, out); // skip transient
    }
    expect(maxOut).toBeLessThan(0.2); // should be well attenuated
  });

  it('boosts at center frequency with peaking filter', () => {
    const fs = 48000;
    const fc = 1000;
    const gainDb = 6;
    const Q = 2;
    const coeffs = designPeaking(fc, fs, gainDb, Q);
    const filter = new BiquadFilter(coeffs);
    // Measure amplitude at fc vs DC
    let maxAtFc = 0;
    for (let i = 0; i < 4800; i++) {
      const input = Math.sin(2 * Math.PI * fc * i / fs);
      const out = Math.abs(filter.process(input));
      if (i > 480) maxAtFc = Math.max(maxAtFc, out);
    }
    // 6dB boost = ~2x amplitude
    expect(maxAtFc).toBeGreaterThan(1.5);
    expect(maxAtFc).toBeLessThan(2.5);
  });

  it('reset clears filter state', () => {
    const coeffs = designLowpass(1000, 48000, 0.707);
    const filter = new BiquadFilter(coeffs);
    filter.process(1.0);
    filter.process(1.0);
    filter.reset();
    // After reset, first output should match a fresh filter
    const fresh = new BiquadFilter(coeffs);
    expect(filter.process(0.5)).toBeCloseTo(fresh.process(0.5), 10);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/dsp/__tests__/biquad.test.ts
```
Expected: FAIL — module not found.

**Step 3: Write implementation**

`src/dsp/biquad.ts`:
```typescript
export interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

export class BiquadFilter {
  private b0: number; private b1: number; private b2: number;
  private a1: number; private a2: number;
  private x1 = 0; private x2 = 0;
  private y1 = 0; private y2 = 0;

  constructor(c: BiquadCoeffs) {
    this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2;
    this.a1 = c.a1; this.a2 = c.a2;
  }

  updateCoeffs(c: BiquadCoeffs): void {
    this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2;
    this.a1 = c.a1; this.a2 = c.a2;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

// Audio EQ Cookbook filters (Robert Bristow-Johnson)

export function designLowpass(fc: number, fs: number, Q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw0) / 2) / a0,
    b1: (1 - cosw0) / a0,
    b2: ((1 - cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designHighpass(fc: number, fs: number, Q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw0) / 2) / a0,
    b1: (-(1 + cosw0)) / a0,
    b2: ((1 + cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designPeaking(fc: number, fs: number, gainDb: number, Q: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosw0) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

export function designLowShelf(fc: number, fs: number, gainDb: number, Q: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) + (A - 1) * cosw0 + sqrtA2alpha;
  return {
    b0: (A * ((A + 1) - (A - 1) * cosw0 + sqrtA2alpha)) / a0,
    b1: (2 * A * ((A - 1) - (A + 1) * cosw0)) / a0,
    b2: (A * ((A + 1) - (A - 1) * cosw0 - sqrtA2alpha)) / a0,
    a1: (-2 * ((A - 1) + (A + 1) * cosw0)) / a0,
    a2: ((A + 1) + (A - 1) * cosw0 - sqrtA2alpha) / a0,
  };
}

export function designHighShelf(fc: number, fs: number, gainDb: number, Q: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cosw0 + sqrtA2alpha;
  return {
    b0: (A * ((A + 1) + (A - 1) * cosw0 + sqrtA2alpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cosw0)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cosw0 - sqrtA2alpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cosw0)) / a0,
    a2: ((A + 1) - (A - 1) * cosw0 - sqrtA2alpha) / a0,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/dsp/__tests__/biquad.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/dsp/biquad.ts src/dsp/__tests__/biquad.test.ts
git commit -m "feat: add biquad filter utility with cookbook designs"
```

---

### Task 3: Jiles-Atherton Hysteresis Model

The core tape saturation engine.

**Files:**
- Create: `src/dsp/hysteresis.ts`
- Create: `src/dsp/__tests__/hysteresis.test.ts`

**Step 1: Write the failing test**

`src/dsp/__tests__/hysteresis.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { HysteresisProcessor } from '../hysteresis';

describe('HysteresisProcessor', () => {
  it('outputs zero for zero input', () => {
    const hp = new HysteresisProcessor(48000);
    const out = hp.process(0);
    expect(out).toBe(0);
  });

  it('produces output for non-zero input', () => {
    const hp = new HysteresisProcessor(48000);
    // Feed a sine wave and check we get output
    let maxOut = 0;
    for (let i = 0; i < 4800; i++) {
      const input = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
      const out = Math.abs(hp.process(input));
      maxOut = Math.max(maxOut, out);
    }
    expect(maxOut).toBeGreaterThan(0);
  });

  it('saturates — output amplitude limited even with increasing input', () => {
    const hp = new HysteresisProcessor(48000);
    hp.setDrive(0.8);
    hp.setSaturation(0.8);
    // Large input
    let maxOut = 0;
    for (let i = 0; i < 9600; i++) {
      const input = 5.0 * Math.sin(2 * Math.PI * 440 * i / 48000);
      const out = Math.abs(hp.process(input));
      if (i > 480) maxOut = Math.max(maxOut, out);
    }
    // Output should be bounded (saturated), not 5x the clean level
    expect(maxOut).toBeLessThan(2.0);
    expect(maxOut).toBeGreaterThan(0.1);
  });

  it('produces no NaN or Infinity', () => {
    const hp = new HysteresisProcessor(48000);
    for (let i = 0; i < 48000; i++) {
      const input = Math.sin(2 * Math.PI * 440 * i / 48000);
      const out = hp.process(input);
      expect(isFinite(out)).toBe(true);
    }
  });

  it('generates harmonics (output differs from input shape)', () => {
    const hp = new HysteresisProcessor(48000);
    hp.setDrive(0.7);
    // Collect output of a sine wave
    const outputs: number[] = [];
    for (let i = 0; i < 4800; i++) {
      const input = Math.sin(2 * Math.PI * 440 * i / 48000);
      outputs.push(hp.process(input));
    }
    // If purely linear, output would be a scaled sine. Check THD > 0.
    // Simple check: output should not be a perfect sine rescale
    const maxOut = Math.max(...outputs.map(Math.abs));
    const normalized = outputs.map(v => v / (maxOut || 1));
    let diffSum = 0;
    for (let i = 0; i < normalized.length; i++) {
      const expected = Math.sin(2 * Math.PI * 440 * i / 48000);
      diffSum += Math.abs(normalized[i] - expected);
    }
    const avgDiff = diffSum / normalized.length;
    expect(avgDiff).toBeGreaterThan(0.01); // not a pure sine
  });

  it('reset clears state', () => {
    const hp = new HysteresisProcessor(48000);
    for (let i = 0; i < 480; i++) hp.process(Math.sin(i * 0.1));
    hp.reset();
    expect(hp.process(0)).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/dsp/__tests__/hysteresis.test.ts
```
Expected: FAIL — module not found.

**Step 3: Write implementation**

`src/dsp/hysteresis.ts`:
```typescript
/**
 * Jiles-Atherton magnetic hysteresis model for tape saturation.
 * Based on Chow Tape Model (Jatin Chowdhury, DAFx 2019).
 *
 * Models the nonlinear H→M relationship of magnetic tape using:
 * - Langevin function for anhysteretic magnetization
 * - RK4 ODE solver for per-sample integration
 * - Alpha-transform derivative for stability
 */
export class HysteresisProcessor {
  // J-A parameters (normalized scale)
  private Ms = 1.0;      // saturation magnetization
  private a = 0.167;     // domain shape (Ms / (0.01 + 6*drive))
  private k = 0.47875;   // pinning (coercivity)
  private c = 0.1;       // reversibility
  private alpha = 1.6e-3; // inter-domain coupling
  private upperLim = 20.0;

  // State
  private M_n1 = 0;      // previous magnetization
  private H_n1 = 0;      // previous applied field
  private H_d_n1 = 0;    // previous dH/dt
  private T: number;     // sample period
  private fs: number;

  // User-facing parameters
  private drive = 0.5;
  private saturation = 0.5;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.T = 1.0 / sampleRate;
    this.cook();
  }

  setDrive(v: number): void {
    this.drive = Math.max(0, Math.min(1, v));
    this.cook();
  }

  setSaturation(v: number): void {
    this.saturation = Math.max(0, Math.min(1, v));
    this.cook();
  }

  setWidth(v: number): void {
    this.c = Math.max(0.01, Math.sqrt(1.0 - Math.max(0, Math.min(1, v))) - 0.01);
  }

  private cook(): void {
    this.Ms = 0.5 + 1.5 * (1.0 - this.saturation);
    this.a = this.Ms / (0.01 + 6.0 * this.drive);
  }

  reset(): void {
    this.M_n1 = 0;
    this.H_n1 = 0;
    this.H_d_n1 = 0;
  }

  process(input: number): number {
    const H = input;

    // Alpha-transform derivative (dAlpha = 0.75 for stability)
    const dAlpha = 0.75;
    const H_d = ((1 + dAlpha) / this.T) * (H - this.H_n1) - dAlpha * this.H_d_n1;

    // Midpoint values for RK4
    const H_mid = (H + this.H_n1) * 0.5;
    const H_d_mid = (H_d + this.H_d_n1) * 0.5;

    // RK4 integration
    const k1 = this.T * this.dMdt(this.M_n1, this.H_n1, this.H_d_n1);
    const k2 = this.T * this.dMdt(this.M_n1 + k1 * 0.5, H_mid, H_d_mid);
    const k3 = this.T * this.dMdt(this.M_n1 + k2 * 0.5, H_mid, H_d_mid);
    const k4 = this.T * this.dMdt(this.M_n1 + k3, H, H_d);

    let M_new = this.M_n1 + (k1 + 2 * k2 + 2 * k3 + k4) / 6.0;

    // NaN/Infinity protection
    if (!isFinite(M_new)) M_new = 0;

    // Update state
    this.H_d_n1 = H_d;
    this.H_n1 = H;
    this.M_n1 = M_new;

    return M_new / this.upperLim;
  }

  private dMdt(M: number, H: number, H_d: number): number {
    const Q = (H + this.alpha * M) / this.a;

    // Langevin function with near-zero guard
    let L_val: number;
    let L_prime: number;
    if (Math.abs(Q) < 0.001) {
      L_val = Q / 3.0;
      L_prime = 1.0 / 3.0;
    } else {
      const cothQ = Math.cosh(Q) / Math.sinh(Q);
      L_val = cothQ - 1.0 / Q;
      L_prime = 1.0 / (Q * Q) - cothQ * cothQ + 1.0;
    }

    const M_an = this.Ms * L_val;
    const M_diff = M_an - M;

    const delta = H_d >= 0 ? 1 : -1;
    const deltaM = delta * M_diff >= 0 ? 1 : 0;
    const kap1 = (1.0 - this.c) * deltaM;

    const f1_denom = (1.0 - this.c) * delta * this.k - this.alpha * M_diff;

    // Protect against division by zero
    const f1 = Math.abs(f1_denom) < 1e-12 ? 0 : kap1 * M_diff / f1_denom;
    const f2 = L_prime * this.c * this.Ms / this.a;
    const f3 = 1.0 - L_prime * this.alpha * this.c * this.Ms / this.a;

    const denom = Math.abs(f3) < 1e-12 ? 1e-12 : f3;
    return H_d * (f1 + f2) / denom;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/dsp/__tests__/hysteresis.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/dsp/hysteresis.ts src/dsp/__tests__/hysteresis.test.ts
git commit -m "feat: add Jiles-Atherton hysteresis model with RK4 solver"
```

---

### Task 4: Oversampling Module

**Files:**
- Create: `src/dsp/oversampling.ts`
- Create: `src/dsp/__tests__/oversampling.test.ts`

**Step 1: Write the failing test**

`src/dsp/__tests__/oversampling.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { Oversampler } from '../oversampling';

describe('Oversampler', () => {
  it('upsamples by factor 2 — doubles length', () => {
    const os = new Oversampler(2);
    const input = new Float32Array([1, 0, -1, 0]);
    const up = os.upsample(input);
    expect(up.length).toBe(8);
  });

  it('downsample after upsample recovers original signal shape', () => {
    const os = new Oversampler(2);
    // Low frequency sine (well below Nyquist) should survive round-trip
    const N = 128;
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      input[i] = Math.sin(2 * Math.PI * 2 * i / N); // 2 cycles in 128 samples
    }
    const up = os.upsample(input);
    const down = os.downsample(up);
    expect(down.length).toBe(N);
    // After transient settles, output should approximate input (with delay)
    // Check correlation rather than exact match due to filter delay
    let maxInput = 0;
    let maxOutput = 0;
    for (let i = 64; i < N; i++) {
      maxInput = Math.max(maxInput, Math.abs(input[i]));
      maxOutput = Math.max(maxOutput, Math.abs(down[i]));
    }
    // Output amplitude should be within 20% of input for a low-freq signal
    expect(maxOutput).toBeGreaterThan(maxInput * 0.5);
    expect(maxOutput).toBeLessThan(maxInput * 1.5);
  });

  it('factor 1 passes through unchanged', () => {
    const os = new Oversampler(1);
    const input = new Float32Array([0.5, -0.3, 0.1]);
    const up = os.upsample(input);
    expect(up.length).toBe(3);
    expect(up[0]).toBeCloseTo(0.5);
    const down = os.downsample(up);
    expect(down.length).toBe(3);
    expect(down[0]).toBeCloseTo(0.5);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/dsp/__tests__/oversampling.test.ts
```
Expected: FAIL

**Step 3: Write implementation**

`src/dsp/oversampling.ts`:
```typescript
/**
 * Oversampler with FIR anti-aliasing filter.
 * Uses windowed-sinc (Blackman) lowpass for up/downsampling.
 */
export class Oversampler {
  private factor: number;
  private kernel: Float32Array;
  private upState: Float32Array;
  private downState: Float32Array;

  constructor(factor: number) {
    this.factor = Math.max(1, Math.round(factor));
    if (this.factor <= 1) {
      this.kernel = new Float32Array(0);
      this.upState = new Float32Array(0);
      this.downState = new Float32Array(0);
      return;
    }
    const filterLen = 31 * this.factor + 1;
    this.kernel = this.designLowpass(filterLen, 1 / this.factor);
    this.upState = new Float32Array(filterLen);
    this.downState = new Float32Array(filterLen);
  }

  private designLowpass(len: number, cutoffNorm: number): Float32Array {
    const kernel = new Float32Array(len);
    const mid = (len - 1) / 2;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoffNorm * x) / (Math.PI * x);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1))
                       + 0.08 * Math.cos(4 * Math.PI * i / (len - 1));
      kernel[i] = sinc * win * cutoffNorm;
      sum += kernel[i];
    }
    const scale = this.factor / sum;
    for (let i = 0; i < len; i++) kernel[i] *= scale;
    return kernel;
  }

  upsample(input: Float32Array): Float32Array {
    if (this.factor <= 1) return input;
    const outLen = input.length * this.factor;
    const output = new Float32Array(outLen);
    // Zero-stuff
    for (let i = 0; i < input.length; i++) {
      output[i * this.factor] = input[i];
    }
    // Apply FIR
    this.applyFir(output, output, this.upState);
    return output;
  }

  downsample(input: Float32Array): Float32Array {
    if (this.factor <= 1) return input;
    const outLen = Math.floor(input.length / this.factor);
    // Apply FIR anti-alias
    const filtered = new Float32Array(input.length);
    this.applyFir(input, filtered, this.downState);
    // Decimate
    const output = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      output[i] = filtered[i * this.factor];
    }
    return output;
  }

  private applyFir(input: Float32Array, output: Float32Array, state: Float32Array): void {
    const kLen = this.kernel.length;
    for (let i = 0; i < input.length; i++) {
      for (let j = kLen - 1; j > 0; j--) state[j] = state[j - 1];
      state[0] = input[i];
      let acc = 0;
      for (let j = 0; j < kLen; j++) acc += state[j] * this.kernel[j];
      output[i] = acc;
    }
  }

  reset(): void {
    this.upState.fill(0);
    this.downState.fill(0);
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/dsp/__tests__/oversampling.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/dsp/oversampling.ts src/dsp/__tests__/oversampling.test.ts
git commit -m "feat: add FIR oversampler with windowed-sinc design"
```

---

### Task 5: Transformer Model

**Files:**
- Create: `src/dsp/transformer.ts`
- Create: `src/dsp/__tests__/transformer.test.ts`

**Step 1: Write the failing test**

`src/dsp/__tests__/transformer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { TransformerModel } from '../transformer';

describe('TransformerModel', () => {
  it('passes signal through without NaN', () => {
    const t = new TransformerModel(48000);
    for (let i = 0; i < 4800; i++) {
      const out = t.process(Math.sin(2 * Math.PI * 440 * i / 48000));
      expect(isFinite(out)).toBe(true);
    }
  });

  it('applies LF coupling — attenuates sub-bass', () => {
    const fs = 48000;
    const t = new TransformerModel(fs);
    // Measure response at 5 Hz vs 1 kHz
    let max5Hz = 0;
    let max1kHz = 0;
    for (let i = 0; i < 48000; i++) {
      const out5 = Math.abs(t.process(Math.sin(2 * Math.PI * 5 * i / fs)));
      if (i > 9600) max5Hz = Math.max(max5Hz, out5);
    }
    t.reset();
    for (let i = 0; i < 48000; i++) {
      const out1k = Math.abs(t.process(Math.sin(2 * Math.PI * 1000 * i / fs)));
      if (i > 9600) max1kHz = Math.max(max1kHz, out1k);
    }
    expect(max5Hz).toBeLessThan(max1kHz); // LF should be attenuated
  });

  it('saturates at high levels', () => {
    const t = new TransformerModel(48000);
    // Compare output amplitude for input=1 vs input=10
    let maxLow = 0, maxHigh = 0;
    for (let i = 0; i < 9600; i++) {
      const out = Math.abs(t.process(Math.sin(2 * Math.PI * 440 * i / 48000)));
      if (i > 2400) maxLow = Math.max(maxLow, out);
    }
    t.reset();
    for (let i = 0; i < 9600; i++) {
      const out = Math.abs(t.process(10 * Math.sin(2 * Math.PI * 440 * i / 48000)));
      if (i > 2400) maxHigh = Math.max(maxHigh, out);
    }
    // 10x input should NOT produce 10x output (saturation)
    expect(maxHigh / maxLow).toBeLessThan(8);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/dsp/__tests__/transformer.test.ts
```

**Step 3: Write implementation**

`src/dsp/transformer.ts`:
```typescript
import { BiquadFilter, designHighpass, designLowpass, designPeaking } from './biquad';

/**
 * Audio transformer model.
 * Models: LF coupling, core saturation, HF resonant rolloff.
 */
export class TransformerModel {
  private hpf: BiquadFilter;  // LF coupling
  private lpf: BiquadFilter;  // HF rolloff + resonance
  private satGain: number;     // drive into saturation

  constructor(sampleRate: number, options?: {
    lfCutoff?: number;    // LF -3dB (default 20 Hz)
    hfResonance?: number; // HF resonant freq (default 50000 Hz)
    hfQ?: number;         // Q of HF resonance (default 0.8)
    satAmount?: number;   // saturation drive (default 1.0)
  }) {
    const lfCutoff = options?.lfCutoff ?? 20;
    const hfRes = options?.hfResonance ?? Math.min(50000, sampleRate * 0.45);
    const hfQ = options?.hfQ ?? 0.8;
    this.satGain = options?.satAmount ?? 1.0;

    this.hpf = new BiquadFilter(designHighpass(lfCutoff, sampleRate, 0.5));
    this.lpf = new BiquadFilter(designLowpass(
      Math.min(hfRes, sampleRate * 0.45), sampleRate, hfQ
    ));
  }

  process(input: number): number {
    // LF coupling
    let x = this.hpf.process(input);
    // Core saturation (Langevin-style soft clip)
    const driven = x * this.satGain;
    if (Math.abs(driven) < 0.001) {
      x = driven; // linear region
    } else {
      x = Math.tanh(driven * 1.5) / 1.5 * this.satGain;
      // Blend slight asymmetry for even harmonics
      x += 0.02 * driven * driven * Math.sign(driven);
    }
    // HF rolloff with resonant peak
    x = this.lpf.process(x);
    return x;
  }

  reset(): void {
    this.hpf.reset();
    this.lpf.reset();
  }
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run src/dsp/__tests__/transformer.test.ts
```

**Step 5: Commit**

```bash
git add src/dsp/transformer.ts src/dsp/__tests__/transformer.test.ts
git commit -m "feat: add transformer model with LF coupling and core saturation"
```

---

### Task 6: Amplifier Model

**Files:**
- Create: `src/dsp/amplifier.ts`
- Create: `src/dsp/__tests__/amplifier.test.ts`

**Step 1: Write the failing test**

`src/dsp/__tests__/amplifier.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { AmplifierModel } from '../amplifier';

describe('AmplifierModel', () => {
  it('tube mode produces asymmetric output (even harmonics)', () => {
    const amp = new AmplifierModel('tube');
    // Positive and negative peaks should differ
    const posOut = amp.process(0.8);
    amp.reset();
    const negOut = amp.process(-0.8);
    expect(Math.abs(posOut)).not.toBeCloseTo(Math.abs(negOut), 1);
  });

  it('transistor mode produces symmetric output', () => {
    const amp = new AmplifierModel('transistor');
    const posOut = amp.process(0.8);
    amp.reset();
    const negOut = amp.process(-0.8);
    expect(Math.abs(posOut)).toBeCloseTo(Math.abs(negOut), 2);
  });

  it('does not produce NaN or Infinity', () => {
    const amp = new AmplifierModel('tube');
    for (let i = 0; i < 4800; i++) {
      const out = amp.process(10 * Math.sin(i * 0.1));
      expect(isFinite(out)).toBe(true);
    }
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/dsp/__tests__/amplifier.test.ts
```

**Step 3: Write implementation**

`src/dsp/amplifier.ts`:
```typescript
/**
 * Tube / transistor amplifier model.
 * - Tube: asymmetric soft clip (even harmonics)
 * - Transistor: symmetric harder clip (odd harmonics)
 */
export class AmplifierModel {
  private mode: 'tube' | 'transistor';
  private drive: number;
  private bias: number; // tube asymmetry

  constructor(mode: 'tube' | 'transistor' = 'tube', drive = 1.0) {
    this.mode = mode;
    this.drive = drive;
    this.bias = mode === 'tube' ? 0.15 : 0;
  }

  setDrive(v: number): void {
    this.drive = v;
  }

  process(input: number): number {
    const x = input * this.drive;
    if (this.mode === 'tube') {
      return this.tubeSaturate(x);
    }
    return this.transistorSaturate(x);
  }

  private tubeSaturate(x: number): number {
    // Asymmetric soft clip: positive side clips differently than negative
    const biased = x + this.bias;
    const saturated = Math.tanh(biased) - Math.tanh(this.bias);
    // Normalize so unity input → ~unity output
    const normFactor = 1.0 / (Math.tanh(1.0 + this.bias) - Math.tanh(this.bias));
    return saturated * normFactor;
  }

  private transistorSaturate(x: number): number {
    // Symmetric hard-knee clip
    const threshold = 0.85;
    const absX = Math.abs(x);
    if (absX < threshold) return x;
    const excess = absX - threshold;
    const compressed = threshold + (1 - threshold) * Math.tanh(excess / (1 - threshold));
    return Math.sign(x) * compressed;
  }

  reset(): void {
    // Stateless — nothing to reset
  }
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run src/dsp/__tests__/amplifier.test.ts
```

**Step 5: Commit**

```bash
git add src/dsp/amplifier.ts src/dsp/__tests__/amplifier.test.ts
git commit -m "feat: add tube/transistor amplifier model"
```

---

### Task 7: EQ Curves (NAB/IEC)

**Files:**
- Create: `src/dsp/eq-curves.ts`
- Create: `src/dsp/__tests__/eq-curves.test.ts`

**Step 1: Write the failing test**

`src/dsp/__tests__/eq-curves.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { TapeEQ } from '../eq-curves';

describe('TapeEQ', () => {
  const fs = 48000;

  it('NAB record EQ boosts high frequencies', () => {
    const eq = new TapeEQ(fs, 'NAB', 15, 'record');
    // Measure 10 kHz vs 100 Hz
    let max10k = 0, max100 = 0;
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(eq.process(Math.sin(2 * Math.PI * 10000 * i / fs)));
      if (i > 9600) max10k = Math.max(max10k, out);
    }
    eq.reset();
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(eq.process(Math.sin(2 * Math.PI * 100 * i / fs)));
      if (i > 9600) max100 = Math.max(max100, out);
    }
    expect(max10k).toBeGreaterThan(max100); // HF boosted on record
  });

  it('NAB playback EQ cuts high frequencies', () => {
    const eq = new TapeEQ(fs, 'NAB', 15, 'playback');
    let max10k = 0, max100 = 0;
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(eq.process(Math.sin(2 * Math.PI * 10000 * i / fs)));
      if (i > 9600) max10k = Math.max(max10k, out);
    }
    eq.reset();
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(eq.process(Math.sin(2 * Math.PI * 100 * i / fs)));
      if (i > 9600) max100 = Math.max(max100, out);
    }
    expect(max10k).toBeLessThan(max100); // HF cut on playback
  });

  it('produces no NaN', () => {
    const eq = new TapeEQ(fs, 'IEC', 7.5, 'record');
    for (let i = 0; i < 4800; i++) {
      expect(isFinite(eq.process(Math.sin(i * 0.1)))).toBe(true);
    }
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/dsp/__tests__/eq-curves.test.ts
```

**Step 3: Write implementation**

`src/dsp/eq-curves.ts`:
```typescript
import { BiquadFilter, designHighShelf, designLowShelf } from './biquad';

/**
 * NAB / IEC tape equalization.
 *
 * Time constants define the shelving frequencies:
 * NAB: T1 = 3180us (50 Hz), T2 = 50us (3183 Hz) at 15 ips
 * IEC: T2 only (no LF time constant)
 */

interface EQTimeConstants {
  t1Us: number | null; // LF time constant in microseconds (null = no LF shelf)
  t2Us: number;        // HF time constant in microseconds
}

const TIME_CONSTANTS: Record<string, Record<number, EQTimeConstants>> = {
  NAB: {
    15:   { t1Us: 3180, t2Us: 50 },
    7.5:  { t1Us: 3180, t2Us: 50 },
    3.75: { t1Us: 3180, t2Us: 90 },
  },
  IEC: {
    15:   { t1Us: null, t2Us: 35 },
    7.5:  { t1Us: null, t2Us: 70 },
    3.75: { t1Us: null, t2Us: 90 },
  },
};

export type EQStandard = 'NAB' | 'IEC';
export type TapeSpeed = 15 | 7.5 | 3.75;
export type EQMode = 'record' | 'playback';

export class TapeEQ {
  private hfShelf: BiquadFilter;
  private lfShelf: BiquadFilter | null;

  constructor(sampleRate: number, standard: EQStandard, speed: TapeSpeed, mode: EQMode) {
    const tc = TIME_CONSTANTS[standard][speed];
    // HF corner frequency from time constant
    const fHF = 1e6 / (2 * Math.PI * tc.t2Us);
    // Record = boost HF, Playback = cut HF
    const hfGainDb = mode === 'record' ? 10 : -10;
    this.hfShelf = new BiquadFilter(
      designHighShelf(Math.min(fHF, sampleRate * 0.45), sampleRate, hfGainDb, 0.707)
    );

    if (tc.t1Us !== null) {
      const fLF = 1e6 / (2 * Math.PI * tc.t1Us);
      // Record = cut LF, Playback = boost LF
      const lfGainDb = mode === 'record' ? -6 : 6;
      this.lfShelf = new BiquadFilter(
        designLowShelf(fLF, sampleRate, lfGainDb, 0.707)
      );
    } else {
      this.lfShelf = null;
    }
  }

  process(input: number): number {
    let x = this.hfShelf.process(input);
    if (this.lfShelf) x = this.lfShelf.process(x);
    return x;
  }

  reset(): void {
    this.hfShelf.reset();
    this.lfShelf?.reset();
  }
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run src/dsp/__tests__/eq-curves.test.ts
```

**Step 5: Commit**

```bash
git add src/dsp/eq-curves.ts src/dsp/__tests__/eq-curves.test.ts
git commit -m "feat: add NAB/IEC tape equalization curves"
```

---

### Task 8: Head Model, Bias, Noise, Transport

**Files:**
- Create: `src/dsp/head-model.ts`
- Create: `src/dsp/bias.ts`
- Create: `src/dsp/noise.ts`
- Create: `src/dsp/transport.ts`
- Create: `src/dsp/__tests__/head-model.test.ts`
- Create: `src/dsp/__tests__/transport.test.ts`

**Step 1: Write failing tests**

`src/dsp/__tests__/head-model.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { HeadModel } from '../head-model';

describe('HeadModel', () => {
  it('produces a LF bump (boost around 50-60 Hz at 15 ips)', () => {
    const fs = 48000;
    const h = new HeadModel(fs, 15);
    // Measure at bump freq vs 1 kHz
    let maxBump = 0, max1k = 0;
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(h.process(Math.sin(2 * Math.PI * 55 * i / fs)));
      if (i > 9600) maxBump = Math.max(maxBump, out);
    }
    h.reset();
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(h.process(Math.sin(2 * Math.PI * 1000 * i / fs)));
      if (i > 9600) max1k = Math.max(max1k, out);
    }
    expect(maxBump).toBeGreaterThan(max1k * 0.9); // bump should boost LF
  });

  it('rolls off high frequencies (gap loss)', () => {
    const fs = 48000;
    const h = new HeadModel(fs, 15);
    let max15k = 0, max1k = 0;
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(h.process(Math.sin(2 * Math.PI * 15000 * i / fs)));
      if (i > 9600) max15k = Math.max(max15k, out);
    }
    h.reset();
    for (let i = 0; i < 48000; i++) {
      const out = Math.abs(h.process(Math.sin(2 * Math.PI * 1000 * i / fs)));
      if (i > 9600) max1k = Math.max(max1k, out);
    }
    expect(max15k).toBeLessThan(max1k);
  });
});
```

`src/dsp/__tests__/transport.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { TransportModel } from '../transport';

describe('TransportModel', () => {
  it('outputs signal without NaN', () => {
    const t = new TransportModel(48000);
    t.setWow(0.5);
    t.setFlutter(0.5);
    for (let i = 0; i < 48000; i++) {
      const out = t.process(Math.sin(2 * Math.PI * 440 * i / 48000));
      expect(isFinite(out)).toBe(true);
    }
  });

  it('with zero wow/flutter, output matches input', () => {
    const t = new TransportModel(48000);
    t.setWow(0);
    t.setFlutter(0);
    // After transient, output ≈ input (just delayed)
    const outputs: number[] = [];
    for (let i = 0; i < 4800; i++) {
      outputs.push(t.process(Math.sin(2 * Math.PI * 440 * i / 48000)));
    }
    // Check that output has similar amplitude to input
    const maxOut = Math.max(...outputs.slice(480).map(Math.abs));
    expect(maxOut).toBeGreaterThan(0.8);
    expect(maxOut).toBeLessThan(1.2);
  });
});
```

**Step 2: Run tests to verify failure**

```bash
npx vitest run src/dsp/__tests__/head-model.test.ts src/dsp/__tests__/transport.test.ts
```

**Step 3: Write implementations**

`src/dsp/head-model.ts`:
```typescript
import { BiquadFilter, designPeaking, designLowpass } from './biquad';

/**
 * Playback head model.
 * Head bump (resonant LF boost) + gap loss (HF rolloff).
 */
export class HeadModel {
  private bumpFilter: BiquadFilter;
  private dipFilter: BiquadFilter;
  private gapLossFilter: BiquadFilter;

  constructor(sampleRate: number, tapeSpeedIps: number) {
    // Head bump frequency depends on tape speed and pole piece width
    // Approximation: ~55 Hz at 15 ips, ~28 Hz at 7.5 ips
    const bumpFreq = tapeSpeedIps * 3.67;
    const dipFreq = bumpFreq * 2;

    this.bumpFilter = new BiquadFilter(
      designPeaking(Math.min(bumpFreq, sampleRate * 0.45), sampleRate, 3, 2.0)
    );
    this.dipFilter = new BiquadFilter(
      designPeaking(Math.min(dipFreq, sampleRate * 0.45), sampleRate, -1.5, 1.5)
    );
    // Gap loss: LPF simulating sinc envelope rolloff
    const gapLossFreq = Math.min(tapeSpeedIps * 1200, sampleRate * 0.45);
    this.gapLossFilter = new BiquadFilter(
      designLowpass(gapLossFreq, sampleRate, 0.6)
    );
  }

  process(input: number): number {
    let x = this.bumpFilter.process(input);
    x = this.dipFilter.process(x);
    x = this.gapLossFilter.process(x);
    return x;
  }

  reset(): void {
    this.bumpFilter.reset();
    this.dipFilter.reset();
    this.gapLossFilter.reset();
  }
}
```

`src/dsp/bias.ts`:
```typescript
/**
 * AC bias oscillator.
 * Mixes a high-frequency bias signal with the audio before the tape stage.
 * Bias level controls recording linearity.
 */
export class BiasOscillator {
  private phase = 0;
  private phaseInc: number;
  private level = 0.5; // 0 = under-biased, 1 = over-biased

  constructor(sampleRate: number, biasFreq = 80000) {
    // Bias frequency is typically 80-150 kHz in real machines
    // We cap at Nyquist/2 for digital domain
    const effectiveFreq = Math.min(biasFreq, sampleRate * 0.4);
    this.phaseInc = (2 * Math.PI * effectiveFreq) / sampleRate;
  }

  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
  }

  process(input: number): number {
    const bias = Math.sin(this.phase) * this.level * 0.5;
    this.phase += this.phaseInc;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return input + bias;
  }

  reset(): void {
    this.phase = 0;
  }
}
```

`src/dsp/noise.ts`:
```typescript
import { BiquadFilter, designPeaking, designHighpass } from './biquad';

/**
 * Shaped tape hiss generator.
 * White noise shaped to emphasize 2-8 kHz (tape hiss spectrum).
 */
export class TapeNoise {
  private level = 0.05;
  private shapeFilter: BiquadFilter;
  private hpf: BiquadFilter;

  constructor(sampleRate: number) {
    // Emphasize 4 kHz region
    this.shapeFilter = new BiquadFilter(
      designPeaking(4000, sampleRate, 6, 1.5)
    );
    // Remove sub-bass rumble from noise
    this.hpf = new BiquadFilter(designHighpass(200, sampleRate, 0.707));
  }

  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
  }

  process(): number {
    if (this.level < 0.001) return 0;
    // White noise
    const white = Math.random() * 2 - 1;
    // Shape it
    let noise = this.hpf.process(this.shapeFilter.process(white));
    return noise * this.level * 0.01;
  }

  reset(): void {
    this.shapeFilter.reset();
    this.hpf.reset();
  }
}
```

`src/dsp/transport.ts`:
```typescript
/**
 * Tape transport model (wow & flutter).
 * Variable delay line with Lagrange interpolation.
 * Wow: slow modulation (~0.5-2 Hz) from reel eccentricity.
 * Flutter: faster modulation (~5-10 Hz) from capstan.
 */
export class TransportModel {
  private buffer: Float32Array;
  private writeIdx = 0;
  private bufferSize: number;
  private fs: number;

  // LFO state
  private wowPhase = 0;
  private flutterPhase = 0;
  private wowDepth = 0;    // 0-1
  private flutterDepth = 0; // 0-1
  private wowRate: number;
  private flutterRate: number;

  // Max delay in samples (enough for deepest modulation)
  private maxDelaySamples: number;
  private baseDelay: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.maxDelaySamples = Math.ceil(sampleRate * 0.05); // 50ms max
    this.baseDelay = this.maxDelaySamples / 2;
    this.bufferSize = this.maxDelaySamples + 4; // extra for interpolation
    this.buffer = new Float32Array(this.bufferSize);
    this.wowRate = 2 * Math.PI * 1.2 / sampleRate;   // ~1.2 Hz
    this.flutterRate = 2 * Math.PI * 6.5 / sampleRate; // ~6.5 Hz
  }

  setWow(v: number): void {
    this.wowDepth = Math.max(0, Math.min(1, v));
  }

  setFlutter(v: number): void {
    this.flutterDepth = Math.max(0, Math.min(1, v));
  }

  process(input: number): number {
    // Write to buffer
    this.buffer[this.writeIdx] = input;

    // Calculate modulated delay
    const wowMod = Math.sin(this.wowPhase) * this.wowDepth * this.maxDelaySamples * 0.3;
    const flutterMod = Math.sin(this.flutterPhase) * this.flutterDepth * this.maxDelaySamples * 0.05;
    const delay = this.baseDelay + wowMod + flutterMod;

    // Advance LFOs
    this.wowPhase += this.wowRate;
    this.flutterPhase += this.flutterRate;
    if (this.wowPhase > 2 * Math.PI) this.wowPhase -= 2 * Math.PI;
    if (this.flutterPhase > 2 * Math.PI) this.flutterPhase -= 2 * Math.PI;

    // Read with cubic Lagrange interpolation
    const readPos = this.writeIdx - delay;
    const readIdx = Math.floor(readPos);
    const frac = readPos - readIdx;

    const s0 = this.readBuffer(readIdx - 1);
    const s1 = this.readBuffer(readIdx);
    const s2 = this.readBuffer(readIdx + 1);
    const s3 = this.readBuffer(readIdx + 2);

    // Cubic interpolation
    const output = s1 + 0.5 * frac * (
      s2 - s0 + frac * (
        2 * s0 - 5 * s1 + 4 * s2 - s3 + frac * (
          3 * (s1 - s2) + s3 - s0
        )
      )
    );

    // Advance write position
    this.writeIdx = (this.writeIdx + 1) % this.bufferSize;

    return output;
  }

  private readBuffer(idx: number): number {
    const wrapped = ((idx % this.bufferSize) + this.bufferSize) % this.bufferSize;
    return this.buffer[wrapped];
  }

  reset(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.wowPhase = 0;
    this.flutterPhase = 0;
  }
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run src/dsp/__tests__/head-model.test.ts src/dsp/__tests__/transport.test.ts
```

**Step 5: Commit**

```bash
git add src/dsp/head-model.ts src/dsp/bias.ts src/dsp/noise.ts src/dsp/transport.ts \
        src/dsp/__tests__/head-model.test.ts src/dsp/__tests__/transport.test.ts
git commit -m "feat: add head model, bias oscillator, tape noise, transport"
```

---

### Task 9: Machine Presets

**Files:**
- Create: `src/dsp/presets.ts`

**Step 1: Write implementation** (data-only, no test needed)

`src/dsp/presets.ts`:
```typescript
export interface MachinePreset {
  name: string;
  eqStandard: 'NAB' | 'IEC';
  ampType: 'tube' | 'transistor';
  // Transformer
  inputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number };
  outputTransformer: { lfCutoff: number; hfResonance: number; hfQ: number; satAmount: number };
  // Hysteresis defaults
  drive: number;
  saturation: number;
  biasDefault: number;
  // Head
  bumpGainDb: number;
  // Transport defaults
  wowDefault: number;
  flutterDefault: number;
  hissDefault: number;
}

export const PRESETS: Record<string, MachinePreset> = {
  studer: {
    name: 'Studer A810',
    eqStandard: 'IEC',
    ampType: 'tube',
    inputTransformer: { lfCutoff: 15, hfResonance: 55000, hfQ: 0.7, satAmount: 0.8 },
    outputTransformer: { lfCutoff: 12, hfResonance: 50000, hfQ: 0.6, satAmount: 0.7 },
    drive: 0.4,
    saturation: 0.5,
    biasDefault: 0.5,
    bumpGainDb: 2.5,
    wowDefault: 0.1,
    flutterDefault: 0.08,
    hissDefault: 0.03,
  },
  ampex: {
    name: 'Ampex ATR-102',
    eqStandard: 'NAB',
    ampType: 'tube',
    inputTransformer: { lfCutoff: 20, hfResonance: 40000, hfQ: 1.0, satAmount: 1.2 },
    outputTransformer: { lfCutoff: 18, hfResonance: 38000, hfQ: 0.9, satAmount: 1.0 },
    drive: 0.5,
    saturation: 0.6,
    biasDefault: 0.55,
    bumpGainDb: 3.5,
    wowDefault: 0.12,
    flutterDefault: 0.06,
    hissDefault: 0.04,
  },
  mci: {
    name: 'MCI JH-24',
    eqStandard: 'NAB',
    ampType: 'transistor',
    inputTransformer: { lfCutoff: 25, hfResonance: 45000, hfQ: 0.9, satAmount: 1.1 },
    outputTransformer: { lfCutoff: 22, hfResonance: 42000, hfQ: 0.8, satAmount: 0.9 },
    drive: 0.55,
    saturation: 0.55,
    biasDefault: 0.48,
    bumpGainDb: 2.0,
    wowDefault: 0.15,
    flutterDefault: 0.1,
    hissDefault: 0.05,
  },
};
```

**Step 2: Commit**

```bash
git add src/dsp/presets.ts
git commit -m "feat: add machine presets (Studer, Ampex, MCI)"
```

---

### Task 10: AudioWorklet Processor

Wires all DSP modules into the tape processing chain.

**Files:**
- Create: `src/worklet/tape-processor.ts`

**Step 1: Write implementation**

`src/worklet/tape-processor.ts`:
```typescript
import { HysteresisProcessor } from '../dsp/hysteresis';
import { TransformerModel } from '../dsp/transformer';
import { AmplifierModel } from '../dsp/amplifier';
import { TapeEQ, type EQStandard, type TapeSpeed } from '../dsp/eq-curves';
import { HeadModel } from '../dsp/head-model';
import { BiasOscillator } from '../dsp/bias';
import { TapeNoise } from '../dsp/noise';
import { TransportModel } from '../dsp/transport';
import { Oversampler } from '../dsp/oversampling';
import { PRESETS } from '../dsp/presets';

class TapeProcessor extends AudioWorkletProcessor {
  private inputXfmr!: TransformerModel[];
  private recordAmp!: AmplifierModel[];
  private bias!: BiasOscillator[];
  private recordEQ!: TapeEQ[];
  private hysteresis!: HysteresisProcessor[];
  private oversampler!: Oversampler[];
  private head!: HeadModel[];
  private playbackAmp!: AmplifierModel[];
  private playbackEQ!: TapeEQ[];
  private outputXfmr!: TransformerModel[];
  private transport!: TransportModel[];
  private noise!: TapeNoise[];

  private alive = true;
  private meterInterval = 50;
  private nextMeterFrame: number;
  private rms = [0, 0];
  private peak = [0, 0];

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'inputGain', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'bias', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'saturation', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'wow', defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'flutter', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'hiss', defaultValue: 0.05, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'outputGain', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1.0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const preset = PRESETS[options?.processorOptions?.preset ?? 'studer'];
    const osf = options?.processorOptions?.oversample ?? 2;
    const speed: TapeSpeed = options?.processorOptions?.tapeSpeed ?? 15;
    const channels = 2;

    this.initDSP(channels, preset, osf, speed);
    this.nextMeterFrame = (this.meterInterval / 1000) * sampleRate;

    this.port.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'set-preset') {
        const p = PRESETS[e.data.value];
        if (p) this.initDSP(channels, p, osf, speed);
      }
      if (e.data.type === 'dispose') this.alive = false;
    };
  }

  private initDSP(
    channels: number,
    preset: typeof PRESETS[string],
    oversampleFactor: number,
    speed: TapeSpeed
  ): void {
    const fs = sampleRate;
    this.inputXfmr = Array.from({ length: channels }, () =>
      new TransformerModel(fs, preset.inputTransformer));
    this.recordAmp = Array.from({ length: channels }, () =>
      new AmplifierModel(preset.ampType, 1.0));
    this.bias = Array.from({ length: channels }, () => {
      const b = new BiasOscillator(fs * oversampleFactor);
      b.setLevel(preset.biasDefault);
      return b;
    });
    this.recordEQ = Array.from({ length: channels }, () =>
      new TapeEQ(fs, preset.eqStandard, speed, 'record'));
    this.hysteresis = Array.from({ length: channels }, () => {
      const h = new HysteresisProcessor(fs * oversampleFactor);
      h.setDrive(preset.drive);
      h.setSaturation(preset.saturation);
      return h;
    });
    this.oversampler = Array.from({ length: channels }, () =>
      new Oversampler(oversampleFactor));
    this.head = Array.from({ length: channels }, () =>
      new HeadModel(fs, speed));
    this.playbackAmp = Array.from({ length: channels }, () =>
      new AmplifierModel(preset.ampType, 0.8));
    this.playbackEQ = Array.from({ length: channels }, () =>
      new TapeEQ(fs, preset.eqStandard, speed, 'playback'));
    this.outputXfmr = Array.from({ length: channels }, () =>
      new TransformerModel(fs, preset.outputTransformer));
    this.transport = Array.from({ length: channels }, () => {
      const t = new TransportModel(fs);
      t.setWow(preset.wowDefault);
      t.setFlutter(preset.flutterDefault);
      return t;
    });
    this.noise = Array.from({ length: channels }, () => {
      const n = new TapeNoise(fs);
      n.setLevel(preset.hissDefault);
      return n;
    });
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return this.alive;

    const inputGain = parameters.inputGain[0];
    const biasVal = parameters.bias[0];
    const driveVal = parameters.drive[0];
    const satVal = parameters.saturation[0];
    const wowVal = parameters.wow[0];
    const flutterVal = parameters.flutter[0];
    const hissVal = parameters.hiss[0];
    const outputGain = parameters.outputGain[0];
    const mixVal = parameters.mix[0];

    for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
      // Update parameters
      this.bias[ch].setLevel(biasVal);
      this.hysteresis[ch].setDrive(driveVal);
      this.hysteresis[ch].setSaturation(satVal);
      this.transport[ch].setWow(wowVal);
      this.transport[ch].setFlutter(flutterVal);
      this.noise[ch].setLevel(hissVal);

      const inp = input[ch];
      const out = output[ch];

      for (let i = 0; i < inp.length; i++) {
        const dry = inp[i];
        let x = dry * inputGain;

        // Input transformer
        x = this.inputXfmr[ch].process(x);
        // Record amplifier
        x = this.recordAmp[ch].process(x);
        // Record EQ
        x = this.recordEQ[ch].process(x);

        // Oversample for hysteresis
        const upBuf = this.oversampler[ch].upsample(new Float32Array([x]));
        for (let j = 0; j < upBuf.length; j++) {
          upBuf[j] = this.bias[ch].process(upBuf[j]);
          upBuf[j] = this.hysteresis[ch].process(upBuf[j]);
        }
        const downBuf = this.oversampler[ch].downsample(upBuf);
        x = downBuf[0] || 0;

        // Playback head
        x = this.head[ch].process(x);
        // Transport (wow/flutter)
        x = this.transport[ch].process(x);
        // Playback amplifier
        x = this.playbackAmp[ch].process(x);
        // Playback EQ
        x = this.playbackEQ[ch].process(x);
        // Output transformer
        x = this.outputXfmr[ch].process(x);
        // Add noise
        x += this.noise[ch].process();

        // Clamp output
        x = Math.max(-2, Math.min(2, x));

        // Dry/wet mix
        out[i] = (dry * (1 - mixVal) + x * mixVal) * outputGain;
      }

      // Metering
      let sum = 0;
      let pk = 0;
      for (let i = 0; i < out.length; i++) {
        const abs = Math.abs(out[i]);
        sum += out[i] * out[i];
        if (abs > pk) pk = abs;
      }
      this.rms[ch] = Math.max(Math.sqrt(sum / out.length), this.rms[ch] * 0.95);
      this.peak[ch] = Math.max(pk, this.peak[ch] * 0.99);
    }

    // Send meter data (throttled)
    this.nextMeterFrame -= 128;
    if (this.nextMeterFrame <= 0) {
      this.nextMeterFrame += (this.meterInterval / 1000) * sampleRate;
      this.port.postMessage({
        type: 'meters',
        rms: this.rms.slice(0, output.length),
        peak: this.peak.slice(0, output.length),
      });
    }

    return this.alive;
  }
}

registerProcessor('tape-processor', TapeProcessor);
```

**Step 2: Commit**

```bash
git add src/worklet/tape-processor.ts
git commit -m "feat: add AudioWorklet tape processor wiring full DSP chain"
```

---

### Task 11: Audio File Loader

**Files:**
- Create: `src/audio/file-loader.ts`

**Step 1: Write implementation**

`src/audio/file-loader.ts`:
```typescript
export class AudioFileLoader {
  private ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private destination: AudioNode;
  private playing = false;
  private startOffset = 0;
  private startTime = 0;
  private onTimeUpdate: ((current: number, duration: number) => void) | null = null;
  private rafId = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  async loadFile(file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.stop();
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get currentTime(): number {
    if (!this.playing) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startTime);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setTimeUpdateCallback(cb: (current: number, duration: number) => void): void {
    this.onTimeUpdate = cb;
  }

  play(): void {
    if (!this.buffer || this.playing) return;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.destination);
    this.source.start(0, this.startOffset);
    this.startTime = this.ctx.currentTime;
    this.playing = true;

    this.source.onended = () => {
      if (this.playing) {
        this.playing = false;
        this.startOffset = 0;
        cancelAnimationFrame(this.rafId);
      }
    };

    this.tickTime();
  }

  stop(): void {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch {}
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
    this.startOffset = 0;
    cancelAnimationFrame(this.rafId);
  }

  pause(): void {
    if (!this.playing) return;
    this.startOffset = this.currentTime;
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch {}
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
    cancelAnimationFrame(this.rafId);
  }

  seek(time: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.startOffset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) this.play();
  }

  private tickTime(): void {
    if (!this.playing) return;
    this.onTimeUpdate?.(this.currentTime, this.duration);
    this.rafId = requestAnimationFrame(() => this.tickTime());
  }
}
```

**Step 2: Commit**

```bash
git add src/audio/file-loader.ts
git commit -m "feat: add audio file loader with playback controls"
```

---

### Task 12: UI Controls (Knobs)

**Files:**
- Create: `src/ui/controls.ts`

**Step 1: Write implementation**

`src/ui/controls.ts`:
```typescript
export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  onChange: (value: number) => void;
}

export class Knob {
  readonly element: HTMLElement;
  private value: number;
  private min: number;
  private max: number;
  private step: number;
  private onChange: (v: number) => void;
  private formatValue: (v: number) => string;
  private indicator: HTMLElement;
  private valueDisplay: HTMLElement;
  private dragging = false;
  private lastY = 0;

  constructor(opts: KnobOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.value = opts.value;
    this.step = opts.step ?? 0.01;
    this.onChange = opts.onChange;
    this.formatValue = opts.formatValue ?? ((v) => v.toFixed(1) + (opts.unit ?? ''));

    this.element = document.createElement('div');
    this.element.className = 'knob-container';
    this.element.innerHTML = `
      <div class="knob-label">${opts.label}</div>
      <div class="knob">
        <div class="knob-track"></div>
        <div class="knob-indicator"></div>
      </div>
      <div class="knob-value"></div>
    `;

    this.indicator = this.element.querySelector('.knob-indicator')!;
    this.valueDisplay = this.element.querySelector('.knob-value')!;
    this.updateVisual();

    const knobEl = this.element.querySelector('.knob')!;
    knobEl.addEventListener('mousedown', this.onMouseDown);
    knobEl.addEventListener('dblclick', () => {
      this.setValue(opts.value); // reset to default
    });
  }

  setValue(v: number): void {
    this.value = Math.max(this.min, Math.min(this.max, v));
    this.updateVisual();
    this.onChange(this.value);
  }

  getValue(): number {
    return this.value;
  }

  private updateVisual(): void {
    const pct = (this.value - this.min) / (this.max - this.min);
    const angle = -135 + pct * 270; // -135 to +135 degrees
    this.indicator.style.transform = `rotate(${angle}deg)`;
    this.valueDisplay.textContent = this.formatValue(this.value);
  }

  private onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this.dragging = true;
    this.lastY = e.clientY;
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return;
    const dy = this.lastY - e.clientY; // up = positive
    this.lastY = e.clientY;
    const range = this.max - this.min;
    const sensitivity = e.shiftKey ? 0.0005 : 0.003;
    this.setValue(this.value + dy * range * sensitivity);
  };

  private onMouseUp = (): void => {
    this.dragging = false;
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
  };
}

export interface SelectOptions {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

export class Select {
  readonly element: HTMLElement;

  constructor(opts: SelectOptions) {
    this.element = document.createElement('div');
    this.element.className = 'select-container';
    const optionsHtml = opts.options
      .map(o => `<option value="${o.value}" ${o.value === opts.value ? 'selected' : ''}>${o.label}</option>`)
      .join('');
    this.element.innerHTML = `
      <div class="select-label">${opts.label}</div>
      <select>${optionsHtml}</select>
    `;
    const select = this.element.querySelector('select')!;
    select.addEventListener('change', () => opts.onChange(select.value));
  }
}
```

**Step 2: Commit**

```bash
git add src/ui/controls.ts
git commit -m "feat: add rotary knob and select UI controls"
```

---

### Task 13: UI Meters

**Files:**
- Create: `src/ui/meter.ts`

**Step 1: Write implementation**

`src/ui/meter.ts`:
```typescript
export class LevelMeter {
  readonly element: HTMLElement;
  private fill: HTMLElement;
  private label: string;
  private value = 0;

  constructor(label: string) {
    this.label = label;
    this.element = document.createElement('div');
    this.element.className = 'meter-container';
    this.element.innerHTML = `
      <span class="meter-label">${label}</span>
      <div class="meter-track">
        <div class="meter-fill"></div>
      </div>
    `;
    this.fill = this.element.querySelector('.meter-fill')!;
  }

  update(rms: number): void {
    // Convert to dB, clamp to -60..0
    const db = rms > 0.00001 ? 20 * Math.log10(rms) : -60;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    this.fill.style.width = `${pct}%`;
    // Color: green < -6dB, yellow -6..0, red > 0
    if (db > 0) this.fill.style.background = '#ff4444';
    else if (db > -6) this.fill.style.background = '#ffaa00';
    else this.fill.style.background = '#44cc44';
  }
}
```

**Step 2: Commit**

```bash
git add src/ui/meter.ts
git commit -m "feat: add level meter UI component"
```

---

### Task 14: UI Layout & App Wiring

**Files:**
- Create: `src/ui/layout.ts`
- Modify: `src/main.ts`
- Modify: `src/styles/main.css`
- Move: `public/index.html` → `index.html` (Vite expects it at root)

**Step 1: Write layout.ts**

`src/ui/layout.ts`:
```typescript
import { Knob, Select } from './controls';
import { LevelMeter } from './meter';

export interface LayoutCallbacks {
  onParamChange: (name: string, value: number) => void;
  onPresetChange: (preset: string) => void;
  onSpeedChange: (speed: number) => void;
  onOversampleChange: (factor: number) => void;
  onFileLoad: (file: File) => void;
  onPlay: () => void;
  onStop: () => void;
  onPause: () => void;
  onSeek: (time: number) => void;
}

export class Layout {
  private app: HTMLElement;
  private knobs: Map<string, Knob> = new Map();
  private inMeterL: LevelMeter;
  private inMeterR: LevelMeter;
  private outMeterL: LevelMeter;
  private outMeterR: LevelMeter;
  private seekBar: HTMLInputElement | null = null;
  private timeDisplay: HTMLElement | null = null;

  constructor(container: HTMLElement, cb: LayoutCallbacks) {
    this.app = container;

    // Header
    const header = document.createElement('header');
    header.innerHTML = `<h1>TAPE SATURATOR</h1>`;
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load Audio';
    loadBtn.className = 'btn';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) cb.onFileLoad(fileInput.files[0]);
    });
    header.appendChild(loadBtn);
    header.appendChild(fileInput);
    this.app.appendChild(header);

    // Drop zone
    this.app.addEventListener('dragover', (e) => { e.preventDefault(); this.app.classList.add('dragover'); });
    this.app.addEventListener('dragleave', () => this.app.classList.remove('dragover'));
    this.app.addEventListener('drop', (e) => {
      e.preventDefault();
      this.app.classList.remove('dragover');
      if (e.dataTransfer?.files[0]) cb.onFileLoad(e.dataTransfer.files[0]);
    });

    // Controls row 1
    const row1 = document.createElement('div');
    row1.className = 'controls-row';

    const knobDefs: Array<{ name: string; label: string; min: number; max: number; value: number; unit?: string; format?: (v: number) => string }> = [
      { name: 'inputGain', label: 'INPUT', min: 0.25, max: 4, value: 1, format: (v) => `${(20 * Math.log10(v)).toFixed(1)}dB` },
      { name: 'bias', label: 'BIAS', min: 0, max: 1, value: 0.5, format: (v) => `${(v * 100).toFixed(0)}%` },
      { name: 'saturation', label: 'SAT', min: 0, max: 1, value: 0.5, format: (v) => `${(v * 100).toFixed(0)}%` },
      { name: 'drive', label: 'DRIVE', min: 0, max: 1, value: 0.5, format: (v) => `${(v * 100).toFixed(0)}%` },
      { name: 'wow', label: 'WOW', min: 0, max: 1, value: 0.15, format: (v) => `${(v * 100).toFixed(0)}%` },
    ];

    for (const def of knobDefs) {
      const knob = new Knob({
        label: def.label, min: def.min, max: def.max, value: def.value,
        formatValue: def.format,
        onChange: (v) => cb.onParamChange(def.name, v),
      });
      this.knobs.set(def.name, knob);
      row1.appendChild(knob.element);
    }
    this.app.appendChild(row1);

    // Controls row 2
    const row2 = document.createElement('div');
    row2.className = 'controls-row';

    const knobDefs2: Array<{ name: string; label: string; min: number; max: number; value: number; format?: (v: number) => string }> = [
      { name: 'flutter', label: 'FLUTTER', min: 0, max: 1, value: 0.1, format: (v) => `${(v * 100).toFixed(0)}%` },
      { name: 'hiss', label: 'HISS', min: 0, max: 1, value: 0.05, format: (v) => `${(v * 100).toFixed(0)}%` },
      { name: 'outputGain', label: 'OUTPUT', min: 0.25, max: 4, value: 1, format: (v) => `${(20 * Math.log10(v)).toFixed(1)}dB` },
      { name: 'mix', label: 'MIX', min: 0, max: 1, value: 1, format: (v) => `${(v * 100).toFixed(0)}%` },
    ];

    for (const def of knobDefs2) {
      const knob = new Knob({
        label: def.label, min: def.min, max: def.max, value: def.value,
        formatValue: def.format,
        onChange: (v) => cb.onParamChange(def.name, v),
      });
      this.knobs.set(def.name, knob);
      row2.appendChild(knob.element);
    }

    // Selects
    const presetSelect = new Select({
      label: 'MACHINE', value: 'studer',
      options: [
        { value: 'studer', label: 'Studer A810' },
        { value: 'ampex', label: 'Ampex ATR-102' },
        { value: 'mci', label: 'MCI JH-24' },
      ],
      onChange: (v) => cb.onPresetChange(v),
    });
    row2.appendChild(presetSelect.element);

    const speedSelect = new Select({
      label: 'SPEED', value: '15',
      options: [
        { value: '15', label: '15 ips' },
        { value: '7.5', label: '7.5 ips' },
        { value: '3.75', label: '3.75 ips' },
      ],
      onChange: (v) => cb.onSpeedChange(parseFloat(v)),
    });
    row2.appendChild(speedSelect.element);

    const osSelect = new Select({
      label: 'OS', value: '2',
      options: [
        { value: '1', label: '1x' },
        { value: '2', label: '2x' },
        { value: '4', label: '4x' },
      ],
      onChange: (v) => cb.onOversampleChange(parseInt(v)),
    });
    row2.appendChild(osSelect.element);

    this.app.appendChild(row2);

    // Meters
    const metersDiv = document.createElement('div');
    metersDiv.className = 'meters';
    this.inMeterL = new LevelMeter('IN L');
    this.inMeterR = new LevelMeter('IN R');
    this.outMeterL = new LevelMeter('OUT L');
    this.outMeterR = new LevelMeter('OUT R');
    metersDiv.appendChild(this.inMeterL.element);
    metersDiv.appendChild(this.inMeterR.element);
    metersDiv.appendChild(this.outMeterL.element);
    metersDiv.appendChild(this.outMeterR.element);
    this.app.appendChild(metersDiv);

    // Playback controls
    const transport = document.createElement('div');
    transport.className = 'transport';
    transport.innerHTML = `
      <button class="btn btn-play">Play</button>
      <button class="btn btn-pause">Pause</button>
      <button class="btn btn-stop">Stop</button>
      <input type="range" class="seek-bar" min="0" max="100" value="0" step="0.1">
      <span class="time-display">0:00 / 0:00</span>
    `;
    transport.querySelector('.btn-play')!.addEventListener('click', cb.onPlay);
    transport.querySelector('.btn-pause')!.addEventListener('click', cb.onPause);
    transport.querySelector('.btn-stop')!.addEventListener('click', cb.onStop);
    this.seekBar = transport.querySelector('.seek-bar') as HTMLInputElement;
    this.seekBar.addEventListener('input', () => {
      const pct = parseFloat(this.seekBar!.value) / 100;
      cb.onSeek(pct);
    });
    this.timeDisplay = transport.querySelector('.time-display')!;
    this.app.appendChild(transport);
  }

  updateMeters(rms: number[], peak: number[]): void {
    this.outMeterL.update(rms[0] ?? 0);
    this.outMeterR.update(rms[1] ?? rms[0] ?? 0);
  }

  updateTime(current: number, duration: number): void {
    if (this.seekBar) {
      this.seekBar.max = '100';
      this.seekBar.value = String(duration > 0 ? (current / duration) * 100 : 0);
    }
    if (this.timeDisplay) {
      this.timeDisplay.textContent = `${this.fmtTime(current)} / ${this.fmtTime(duration)}`;
    }
  }

  private fmtTime(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }
}
```

**Step 2: Write main.ts**

`src/main.ts`:
```typescript
import { Layout } from './ui/layout';
import { AudioFileLoader } from './audio/file-loader';

let audioCtx: AudioContext | null = null;
let tapeNode: AudioWorkletNode | null = null;
let loader: AudioFileLoader | null = null;
let layout: Layout | null = null;

async function init() {
  const app = document.getElementById('app')!;

  layout = new Layout(app, {
    onParamChange: (name, value) => {
      if (tapeNode) {
        const param = tapeNode.parameters.get(name);
        if (param) param.setValueAtTime(value, audioCtx!.currentTime);
      }
    },
    onPresetChange: (preset) => {
      tapeNode?.port.postMessage({ type: 'set-preset', value: preset });
    },
    onSpeedChange: (_speed) => {
      // Requires re-init of processor — handled via message
      tapeNode?.port.postMessage({ type: 'set-speed', value: _speed });
    },
    onOversampleChange: (_factor) => {
      tapeNode?.port.postMessage({ type: 'set-oversample', value: _factor });
    },
    onFileLoad: async (file) => {
      await ensureAudioContext();
      await loader!.loadFile(file);
    },
    onPlay: () => loader?.play(),
    onPause: () => loader?.pause(),
    onStop: () => loader?.stop(),
    onSeek: (pct) => {
      if (loader) loader.seek(pct * loader.duration);
    },
  });
}

async function ensureAudioContext() {
  if (audioCtx) return;
  audioCtx = new AudioContext();

  // Load worklet
  const workletUrl = new URL('./worklet/tape-processor.ts', import.meta.url).href;
  await audioCtx.audioWorklet.addModule(workletUrl);

  tapeNode = new AudioWorkletNode(audioCtx, 'tape-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { preset: 'studer', oversample: 2, tapeSpeed: 15 },
  });

  tapeNode.connect(audioCtx.destination);

  tapeNode.port.onmessage = (e: MessageEvent) => {
    if (e.data.type === 'meters') {
      layout?.updateMeters(e.data.rms, e.data.peak);
    }
  };

  loader = new AudioFileLoader(audioCtx, tapeNode);
  loader.setTimeUpdateCallback((current, duration) => {
    layout?.updateTime(current, duration);
  });
}

init();
```

**Step 3: Write CSS**

`src/styles/main.css`:
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: 'Inter', system-ui, sans-serif;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
}

#app {
  background: #16213e;
  border-radius: 16px;
  padding: 32px;
  max-width: 900px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
#app.dragover { outline: 2px dashed #4ecdc4; }

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
h1 {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #4ecdc4;
}

.btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #3a3a5a;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.2s;
}
.btn:hover { background: #3a3a6a; }

.controls-row {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
  justify-content: center;
}

.knob-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 72px;
}
.knob-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #8888aa;
  text-transform: uppercase;
}
.knob {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #2a2a4a;
  border: 2px solid #3a3a5a;
  position: relative;
  cursor: grab;
  user-select: none;
}
.knob:active { cursor: grabbing; }
.knob-track {
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  border: 2px solid #1a1a2e;
}
.knob-indicator {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 2px;
  height: 14px;
  background: #4ecdc4;
  transform-origin: bottom center;
  margin-left: -1px;
  border-radius: 1px;
}
.knob-value {
  font-size: 11px;
  color: #aaaacc;
  font-variant-numeric: tabular-nums;
}

.select-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.select-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #8888aa;
  text-transform: uppercase;
}
.select-container select {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #3a3a5a;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.meters {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 16px 0;
}
.meter-container {
  display: flex;
  align-items: center;
  gap: 8px;
}
.meter-label {
  font-size: 10px;
  width: 40px;
  text-align: right;
  color: #8888aa;
}
.meter-track {
  flex: 1;
  height: 8px;
  background: #1a1a2e;
  border-radius: 4px;
  overflow: hidden;
}
.meter-fill {
  height: 100%;
  width: 0%;
  background: #44cc44;
  border-radius: 4px;
  transition: width 0.05s linear;
}

.transport {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.seek-bar {
  flex: 1;
  accent-color: #4ecdc4;
}
.time-display {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #8888aa;
  min-width: 90px;
}
```

**Step 4: Move index.html to root for Vite**

```bash
mv public/index.html index.html
rmdir public
```

Update `index.html` to reference CSS from src:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tape Saturator</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 5: Commit**

```bash
git add src/ui/ src/main.ts src/styles/ index.html
git commit -m "feat: add UI layout, controls, meters, and main app wiring"
```

---

### Task 15: Integration Test & Final Verification

**Step 1: Run all unit tests**

```bash
npx vitest run
```
Expected: All tests pass.

**Step 2: Start dev server and verify**

```bash
npx vite
```
Expected: App loads, UI renders, audio can be loaded and processed.

**Step 3: Fix any issues found during manual testing**

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete tape saturation plugin MVP"
```
