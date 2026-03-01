/**
 * Knob and Select UI components for the tape saturator interface.
 */

// ---------------------------------------------------------------------------
// Knob
// ---------------------------------------------------------------------------

export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  onChange?: (v: number) => void;
}

export class Knob {
  readonly element: HTMLDivElement;

  private readonly min: number;
  private readonly max: number;
  private readonly defaultValue: number;
  private readonly step: number;
  private readonly unit: string;
  private readonly formatValue: (v: number) => string;
  private readonly onChange: ((v: number) => void) | undefined;

  private value: number;
  private readonly indicatorEl: HTMLDivElement;
  private readonly valueEl: HTMLDivElement;

  /** Sensitivity in value-range fraction per pixel of drag. */
  private static readonly SENSITIVITY = 0.003;
  private static readonly FINE_SENSITIVITY = 0.0005;

  constructor(opts: KnobOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.defaultValue = opts.value;
    this.value = opts.value;
    this.step = opts.step ?? 0;
    this.unit = opts.unit ?? '';
    this.formatValue = opts.formatValue ?? ((v: number) => `${v}`);
    this.onChange = opts.onChange;

    // Build DOM
    this.element = document.createElement('div');
    this.element.className = 'knob-container';

    const labelEl = document.createElement('div');
    labelEl.className = 'knob-label';
    labelEl.textContent = opts.label;

    const knobEl = document.createElement('div');
    knobEl.className = 'knob';

    const trackEl = document.createElement('div');
    trackEl.className = 'knob-track';

    this.indicatorEl = document.createElement('div');
    this.indicatorEl.className = 'knob-indicator';

    knobEl.appendChild(trackEl);
    knobEl.appendChild(this.indicatorEl);

    this.valueEl = document.createElement('div');
    this.valueEl.className = 'knob-value';

    this.element.appendChild(labelEl);
    this.element.appendChild(knobEl);
    this.element.appendChild(this.valueEl);

    this.updateVisual();

    // --- Mouse drag interaction ---
    let lastY = 0;

    const onMouseMove = (e: MouseEvent) => {
      const dy = lastY - e.clientY; // up = positive
      lastY = e.clientY;
      const range = this.max - this.min;
      const sensitivity = e.shiftKey ? Knob.FINE_SENSITIVITY : Knob.SENSITIVITY;
      this.setValue(this.value + dy * range * sensitivity);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    knobEl.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      lastY = e.clientY;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Double-click to reset
    knobEl.addEventListener('dblclick', () => {
      this.setValue(this.defaultValue);
    });
  }

  setValue(v: number): void {
    let clamped = Math.max(this.min, Math.min(this.max, v));
    if (this.step > 0) {
      clamped = Math.round(clamped / this.step) * this.step;
    }
    this.value = clamped;
    this.updateVisual();
    this.onChange?.(this.value);
  }

  getValue(): number {
    return this.value;
  }

  private updateVisual(): void {
    const pct = (this.value - this.min) / (this.max - this.min);
    // Map 0..1 to -135..+135 degrees
    const deg = -135 + pct * 270;
    this.indicatorEl.style.transform = `rotate(${deg}deg)`;
    this.valueEl.textContent = this.formatValue(this.value) + this.unit;
  }
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectOptions {
  label: string;
  options: SelectOption[];
  value: string;
  onChange?: (v: string) => void;
}

export class Select {
  readonly element: HTMLDivElement;
  private readonly selectEl: HTMLSelectElement;

  constructor(opts: SelectOptions) {
    this.element = document.createElement('div');
    this.element.className = 'select-container';

    const labelEl = document.createElement('div');
    labelEl.className = 'select-label';
    labelEl.textContent = opts.label;

    this.selectEl = document.createElement('select');
    for (const opt of opts.options) {
      const optionEl = document.createElement('option');
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      this.selectEl.appendChild(optionEl);
    }
    this.selectEl.value = opts.value;

    this.selectEl.addEventListener('change', () => {
      opts.onChange?.(this.selectEl.value);
    });

    this.element.appendChild(labelEl);
    this.element.appendChild(this.selectEl);
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(v: string): void {
    this.selectEl.value = v;
  }
}
