/**
 * Full application layout for the Tape Saturator UI.
 *
 * Assembles the header, control rows, meters, and transport bar,
 * then wires them to the callback interface consumed by main.ts.
 */

import { Knob, Select } from './controls';
import { LevelMeter } from './meter';

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a linear gain value as dB with one decimal place. */
function fmtDb(v: number): string {
  const db = 20 * Math.log10(v);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** Format a 0-1 value as a percentage. */
function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export class Layout {
  private readonly meterL: LevelMeter;
  private readonly meterR: LevelMeter;
  private readonly seekBar: HTMLInputElement;
  private readonly timeDisplay: HTMLDivElement;

  constructor(container: HTMLElement, callbacks: LayoutCallbacks) {
    container.innerHTML = '';

    // ---- Header ----
    const header = document.createElement('header');

    const title = document.createElement('h1');
    title.textContent = 'TAPE SATURATOR';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn';
    loadBtn.textContent = 'Load Audio';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';

    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) callbacks.onFileLoad(file);
    });

    header.appendChild(title);
    header.appendChild(loadBtn);
    header.appendChild(fileInput);
    container.appendChild(header);

    // ---- Drag-and-drop on entire app ----
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      container.classList.add('dragover');
    });
    container.addEventListener('dragleave', () => {
      container.classList.remove('dragover');
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.classList.remove('dragover');
      const file = e.dataTransfer?.files[0];
      if (file) callbacks.onFileLoad(file);
    });

    // ---- Controls row 1 ----
    const row1 = document.createElement('div');
    row1.className = 'controls-row';

    const inputKnob = new Knob({
      label: 'INPUT', min: 0.25, max: 4, value: 1,
      formatValue: fmtDb,
      onChange: (v) => callbacks.onParamChange('inputGain', v),
    });
    const biasKnob = new Knob({
      label: 'BIAS', min: 0, max: 1, value: 0.5,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('bias', v),
    });
    const satKnob = new Knob({
      label: 'SAT', min: 0, max: 1, value: 0.5,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('saturation', v),
    });
    const driveKnob = new Knob({
      label: 'DRIVE', min: 0, max: 1, value: 0.5,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('drive', v),
    });
    const wowKnob = new Knob({
      label: 'WOW', min: 0, max: 1, value: 0.15,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('wow', v),
    });

    row1.appendChild(inputKnob.element);
    row1.appendChild(biasKnob.element);
    row1.appendChild(satKnob.element);
    row1.appendChild(driveKnob.element);
    row1.appendChild(wowKnob.element);
    container.appendChild(row1);

    // ---- Controls row 2 ----
    const row2 = document.createElement('div');
    row2.className = 'controls-row';

    const flutterKnob = new Knob({
      label: 'FLUTTER', min: 0, max: 1, value: 0.1,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('flutter', v),
    });
    const hissKnob = new Knob({
      label: 'HISS', min: 0, max: 1, value: 0.05,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('hiss', v),
    });
    const outputKnob = new Knob({
      label: 'OUTPUT', min: 0.25, max: 4, value: 1,
      formatValue: fmtDb,
      onChange: (v) => callbacks.onParamChange('outputGain', v),
    });
    const mixKnob = new Knob({
      label: 'MIX', min: 0, max: 1, value: 1,
      formatValue: fmtPct,
      onChange: (v) => callbacks.onParamChange('mix', v),
    });

    const machineSelect = new Select({
      label: 'MACHINE',
      options: [
        { value: 'studer', label: 'Studer A810' },
        { value: 'ampex', label: 'Ampex ATR-102' },
        { value: 'mci', label: 'MCI JH-24' },
      ],
      value: 'studer',
      onChange: (v) => callbacks.onPresetChange(v),
    });

    const speedSelect = new Select({
      label: 'SPEED',
      options: [
        { value: '15', label: '15 ips' },
        { value: '7.5', label: '7.5 ips' },
        { value: '3.75', label: '3.75 ips' },
      ],
      value: '15',
      onChange: (v) => callbacks.onSpeedChange(parseFloat(v)),
    });

    const osSelect = new Select({
      label: 'OS',
      options: [
        { value: '1', label: '1x' },
        { value: '2', label: '2x' },
        { value: '4', label: '4x' },
      ],
      value: '2',
      onChange: (v) => callbacks.onOversampleChange(parseInt(v, 10)),
    });

    row2.appendChild(flutterKnob.element);
    row2.appendChild(hissKnob.element);
    row2.appendChild(outputKnob.element);
    row2.appendChild(mixKnob.element);
    row2.appendChild(machineSelect.element);
    row2.appendChild(speedSelect.element);
    row2.appendChild(osSelect.element);
    container.appendChild(row2);

    // ---- Meters ----
    const metersRow = document.createElement('div');
    metersRow.className = 'meters-row';

    this.meterL = new LevelMeter('OUT L');
    this.meterR = new LevelMeter('OUT R');

    metersRow.appendChild(this.meterL.element);
    metersRow.appendChild(this.meterR.element);
    container.appendChild(metersRow);

    // ---- Transport ----
    const transport = document.createElement('div');
    transport.className = 'transport';

    const playBtn = document.createElement('button');
    playBtn.className = 'btn transport-btn';
    playBtn.textContent = 'Play';
    playBtn.addEventListener('click', () => callbacks.onPlay());

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'btn transport-btn';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', () => callbacks.onPause());

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn transport-btn';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => callbacks.onStop());

    this.seekBar = document.createElement('input');
    this.seekBar.type = 'range';
    this.seekBar.className = 'seek-bar';
    this.seekBar.min = '0';
    this.seekBar.max = '0';
    this.seekBar.step = '0.01';
    this.seekBar.value = '0';
    this.seekBar.addEventListener('input', () => {
      callbacks.onSeek(parseFloat(this.seekBar.value));
    });

    this.timeDisplay = document.createElement('div');
    this.timeDisplay.className = 'time-display';
    this.timeDisplay.textContent = '0:00 / 0:00';

    transport.appendChild(playBtn);
    transport.appendChild(pauseBtn);
    transport.appendChild(stopBtn);
    transport.appendChild(this.seekBar);
    transport.appendChild(this.timeDisplay);
    container.appendChild(transport);
  }

  /** Update level meters from worklet meter data. */
  updateMeters(rms: number[], _peak: number[]): void {
    this.meterL.update(rms[0] ?? 0);
    this.meterR.update(rms[1] ?? 0);
  }

  /** Update the transport seek bar and time display. */
  updateTime(current: number, duration: number): void {
    this.seekBar.max = String(duration);
    this.seekBar.value = String(current);
    this.timeDisplay.textContent = `${this.fmtTime(current)} / ${this.fmtTime(duration)}`;
  }

  /** Format seconds as m:ss. */
  private fmtTime(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}
