import { describe, it, expect } from 'vitest';
import { PRESETS, FORMULAS } from '../presets';

describe('per-preset tape formulation', () => {
  it('each preset has a defaultFormula that exists in FORMULAS with k, c, and alpha', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.defaultFormula, `${name} missing defaultFormula`).toBeDefined();
      const formula = FORMULAS[preset.defaultFormula];
      expect(formula, `${name} references unknown formula ${preset.defaultFormula}`).toBeDefined();
      expect(typeof formula.k).toBe('number');
      expect(typeof formula.c).toBe('number');
      expect(typeof formula.alpha).toBe('number');
    }
  });

  it('presets have different k values for different tape stocks', () => {
    const kValues = Object.values(PRESETS).map(p => FORMULAS[p.defaultFormula].k);
    // Not all the same
    const unique = new Set(kValues);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('k values are in physically plausible range (0.2-0.8)', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const k = FORMULAS[preset.defaultFormula].k;
      expect(k, `${name} k out of range`).toBeGreaterThan(0.2);
      expect(k, `${name} k out of range`).toBeLessThan(0.8);
    }
  });

  it('alpha values are in plausible range (1e-4 to 5e-3)', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const alpha = FORMULAS[preset.defaultFormula].alpha;
      expect(alpha, `${name} alpha out of range`).toBeGreaterThan(1e-4);
      expect(alpha, `${name} alpha out of range`).toBeLessThan(5e-3);
    }
  });
});
