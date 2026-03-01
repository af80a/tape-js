/**
 * Level meter component for displaying audio output levels.
 *
 * Converts linear RMS values to dB and displays a colour-coded bar:
 *   green  < -6 dB
 *   yellow   -6..0 dB
 *   red    >  0 dB
 */

export class LevelMeter {
  readonly element: HTMLDivElement;
  private readonly fillEl: HTMLDivElement;

  constructor(label: string) {
    this.element = document.createElement('div');
    this.element.className = 'meter-container';

    const labelEl = document.createElement('span');
    labelEl.className = 'meter-label';
    labelEl.textContent = label;

    const trackEl = document.createElement('div');
    trackEl.className = 'meter-track';

    this.fillEl = document.createElement('div');
    this.fillEl.className = 'meter-fill';

    trackEl.appendChild(this.fillEl);
    this.element.appendChild(labelEl);
    this.element.appendChild(trackEl);
  }

  /** Update the meter with a linear RMS value. */
  update(rms: number): void {
    // Convert to dB, clamp to [-60, 0]
    const db = rms > 0 ? 20 * Math.log10(rms) : -60;
    const clamped = Math.max(-60, Math.min(0, db));

    // Map -60..0 to 0..100%
    const pct = ((clamped + 60) / 60) * 100;
    this.fillEl.style.width = `${pct}%`;

    // Colour coding
    if (db > 0) {
      this.fillEl.style.backgroundColor = '#ff4444';
    } else if (db > -6) {
      this.fillEl.style.backgroundColor = '#ffcc00';
    } else {
      this.fillEl.style.backgroundColor = '#44cc44';
    }
  }
}
