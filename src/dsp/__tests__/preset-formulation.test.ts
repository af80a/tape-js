import { describe, it, expect } from 'vitest';
import { PRESETS } from '../presets';

describe('per-preset tape formulation', () => {
  it('each preset has tapeFormulation with k, c, and alpha', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.tapeFormulation, `${name} missing tapeFormulation`).toBeDefined();
      expect(typeof preset.tapeFormulation!.k).toBe('number');
      expect(typeof preset.tapeFormulation!.c).toBe('number');
      expect(typeof preset.tapeFormulation!.alpha).toBe('number');
    }
  });

  it('presets have different k values for different tape stocks', () => {
    const kValues = Object.values(PRESETS).map(p => p.tapeFormulation!.k);
    // Not all the same
    const unique = new Set(kValues);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('k values are in physically plausible range (0.2-0.8)', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const k = preset.tapeFormulation!.k;
      expect(k, `${name} k out of range`).toBeGreaterThan(0.2);
      expect(k, `${name} k out of range`).toBeLessThan(0.8);
    }
  });

  it('alpha values are in plausible range (1e-4 to 5e-3)', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const alpha = preset.tapeFormulation!.alpha;
      expect(alpha, `${name} alpha out of range`).toBeGreaterThan(1e-4);
      expect(alpha, `${name} alpha out of range`).toBeLessThan(5e-3);
    }
  });
});
