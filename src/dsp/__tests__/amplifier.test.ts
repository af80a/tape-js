import { describe, it, expect } from 'vitest';
import { AmplifierModel } from '../amplifier';

describe('AmplifierModel', () => {
  describe('tube mode', () => {
    it('produces asymmetric clipping: positive and negative peaks differ', () => {
      const amp = new AmplifierModel('tube', 2.0);

      const outPositive = amp.process(0.8);
      const outNegative = amp.process(-0.8);

      // Tube mode should produce asymmetric saturation (even harmonics)
      // The absolute values of positive and negative outputs should differ
      // We compare to 1 decimal place — they should NOT be equal
      const absPos = Math.abs(outPositive);
      const absNeg = Math.abs(outNegative);

      expect(
        Math.round(absPos * 10) !== Math.round(absNeg * 10),
      ).toBe(true);
    });
  });

  describe('transistor mode', () => {
    it('produces symmetric clipping: positive and negative peaks match', () => {
      const amp = new AmplifierModel('transistor', 2.0);

      const outPositive = amp.process(0.8);
      const outNegative = amp.process(-0.8);

      // Transistor mode should produce symmetric saturation (odd harmonics)
      // The absolute values should be equal to 2 decimal places
      expect(Math.abs(outPositive)).toBeCloseTo(Math.abs(outNegative), 2);
    });
  });

  describe('numerical stability', () => {
    it('produces no NaN or Infinity for driven signals', () => {
      const modes: Array<'tube' | 'transistor'> = ['tube', 'transistor'];

      for (const mode of modes) {
        const amp = new AmplifierModel(mode, 5.0);

        // Test with a variety of input levels
        const testInputs = [0, 0.1, -0.1, 0.5, -0.5, 1.0, -1.0, 5.0, -5.0, 100, -100];

        for (const input of testInputs) {
          const output = amp.process(input);
          expect(Number.isFinite(output)).toBe(true);
        }
      }
    });
  });

  describe('setDrive', () => {
    it('updates the drive parameter', () => {
      const amp = new AmplifierModel('tube', 1.0);

      // Low drive should produce less saturation
      const outLowDrive = amp.process(0.5);

      amp.setDrive(5.0);
      const outHighDrive = amp.process(0.5);

      // Higher drive should produce a different output
      expect(outLowDrive).not.toBe(outHighDrive);
    });
  });

  describe('reset', () => {
    it('is callable (stateless model)', () => {
      const amp = new AmplifierModel('tube', 1.0);
      amp.process(0.5);

      // reset should not throw
      expect(() => amp.reset()).not.toThrow();
    });
  });
});
