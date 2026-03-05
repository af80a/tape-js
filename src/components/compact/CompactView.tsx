import { useCallback } from 'react';
import { useAudioEngine } from '../../stores/audio-engine';
import { useStageParams } from '../../stores/stage-params';
import { Knob } from '../controls/Knob';
import { Select } from '../controls/Select';
import { ToggleButton } from '../controls/ToggleButton';
import { FORMULAS } from '../../dsp/presets';

function fmtDb(v: number): string {
  const db = 20 * Math.log10(v);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtRef(v: number): string {
  return `${v.toFixed(0)} dB`;
}

function fmtColor(v: number): string {
  if (v < -0.01) return `Dark ${Math.round(Math.abs(v) * 100)}%`;
  if (v > 0.01) return `Bright ${Math.round(v * 100)}%`;
  return 'Neutral';
}

function bumpProfileFromGain(gainDb: number): 'flat' | 'subtle' | 'massive' {
  const profiles = [
    { key: 'flat' as const, gainDb: 0 },
    { key: 'subtle' as const, gainDb: 1.5 },
    { key: 'massive' as const, gainDb: 3.5 },
  ];
  return profiles.reduce((best, next) =>
    Math.abs(next.gainDb - gainDb) < Math.abs(best.gainDb - gainDb) ? next : best
  ).key;
}

function bumpGainFromProfile(profile: string): number {
  if (profile === 'flat') return 0;
  if (profile === 'subtle') return 1.5;
  return 3.5;
}

interface CompactViewProps {
  onPresetChange: (preset: string) => void;
}

export function CompactView({ onPresetChange }: CompactViewProps) {
  const bypassed = useAudioEngine((s) => s.globalBypassed);
  const tapeSpeed = useAudioEngine((s) => s.tapeSpeed);
  const oversample = useAudioEngine((s) => s.oversample);
  const formula = useAudioEngine((s) => s.formula);
  const stages = useStageParams((s) => s.stages);
  const ampType = useStageParams((s) => s.stages.recordAmp.variant) as 'tube' | 'transistor';
  const setGlobalBypass = useAudioEngine((s) => s.setGlobalBypass);
  const setHeadroom = useAudioEngine((s) => s.setHeadroom);
  const setTapeSpeed = useAudioEngine((s) => s.setTapeSpeed);
  const setOversample = useAudioEngine((s) => s.setOversample);
  const setFormula = useAudioEngine((s) => s.setFormula);
  const setAmpType = useStageParams((s) => s.setAmpType);
  const headroom = useAudioEngine((s) => s.headroom);
  const preset = useStageParams((s) => s.currentPreset);
  const setStageParam = useStageParams((s) => s.setStageParam);
  const inputGain = stages.inputXfmr.params.inputGain ?? 1.0;
  const biasLevel = stages.bias.params.level ?? 0.5;
  const hysteresisSaturation = stages.hysteresis.params.saturation ?? 0.5;
  const hysteresisDrive = stages.hysteresis.params.drive ?? 0.5;
  const recordAmpDrive = stages.recordAmp.params.drive ?? 0.5;
  const wow = stages.transport.params.wow ?? 0.15;
  const flutter = stages.transport.params.flutter ?? 0.1;
  const hiss = stages.noise.params.hiss ?? 0.05;
  const color = stages.recordEQ.params.color ?? 0;
  const outputGain = stages.output.params.outputGain ?? 1.0;
  const headBump = stages.head.params.bumpGainDb ?? 0;
  const bump = bumpProfileFromGain(headBump);

  const handleBypass = useCallback(
    (v: boolean) => {
      setGlobalBypass(v);
    },
    [setGlobalBypass],
  );

  const handlePresetChange = useCallback(
    (v: string) => {
      onPresetChange(v);
    },
    [onPresetChange],
  );

  const handleSpeedChange = useCallback(
    (v: string) => {
      setTapeSpeed(parseFloat(v));
    },
    [setTapeSpeed],
  );

  const handleOversampleChange = useCallback(
    (v: string) => {
      setOversample(parseInt(v, 10));
    },
    [setOversample],
  );

  const handleFormulaChange = useCallback(
    (v: string) => {
      setFormula(v);
      const f = FORMULAS[v];
      if (f) {
        setStageParam('hysteresis', 'k', f.k);
        setStageParam('hysteresis', 'c', f.c);
      }
    },
    [setFormula, setStageParam],
  );

  const handleAmpTypeChange = useCallback(
    (v: string) => {
      setAmpType(v as 'tube' | 'transistor');
    },
    [setAmpType],
  );

  const handleBumpChange = useCallback(
    (v: string) => {
      setStageParam('head', 'bumpGainDb', bumpGainFromProfile(v));
    },
    [setStageParam],
  );

  return (
    <div className="compact-controls">
      {/* Section 1: Character */}
      <section className="compact-section">
        <h3 className="compact-section__label">Character</h3>
        <div className="controls-row compact-controls-row">
          <Knob
            label="INPUT" min={0.25} max={4} value={inputGain}
            formatValue={fmtDb}
            onChange={(v) => { setStageParam('inputXfmr', 'inputGain', v); }}
          />
          <Knob
            label="BIAS" min={0} max={1} value={biasLevel}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('bias', 'level', v); }}
          />
          <Knob
            label="SAT" min={0} max={1} value={hysteresisSaturation}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('hysteresis', 'saturation', v); }}
          />
          <Knob
            label="DRIVE" min={0} max={1} value={hysteresisDrive}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('hysteresis', 'drive', v); }}
          />
          <Knob
            label="AMP" min={0} max={1} value={recordAmpDrive}
            formatValue={fmtPct}
            onChange={(v) => {
              setStageParam('recordAmp', 'drive', v);
              setStageParam('playbackAmp', 'drive', Math.max(0, Math.min(1, v * 0.8)));
            }}
          />
          <Knob
            label="WOW" min={0} max={1} value={wow}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('transport', 'wow', v); }}
          />
          <Knob
            label="FLUTTER" min={0} max={1} value={flutter}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('transport', 'flutter', v); }}
          />
        </div>
      </section>

      {/* Section 2: Machine */}
      <section className="compact-section">
        <h3 className="compact-section__label">Machine</h3>
        <div className="controls-row compact-controls-row compact-controls-row--6col">
          <Select
            label="MACHINE"
            options={[
              { value: 'studer', label: 'Studer A810' },
              { value: 'ampex', label: 'Ampex ATR-102' },
              { value: 'mci', label: 'MCI JH-24' },
            ]}
            value={preset}
            onChange={handlePresetChange}
          />
          <Select
            label="FORMULA"
            options={[
              { value: '456', label: 'Ampex 456' },
              { value: '499', label: 'Quantegy 499' },
              { value: '900', label: 'BASF 900' },
            ]}
            value={formula}
            onChange={handleFormulaChange}
          />
          <Select
            label="AMP TYPE"
            options={[
              { value: 'transistor', label: 'Solid State' },
              { value: 'tube', label: 'Tube 12AX7' },
            ]}
            value={ampType}
            onChange={handleAmpTypeChange}
          />
          <Select
            label="BUMP"
            options={[
              { value: 'flat', label: 'Flat (0dB)' },
              { value: 'subtle', label: 'Subtle (+1.5dB)' },
              { value: 'massive', label: 'Massive (+3.5dB)' },
            ]}
            value={bump}
            onChange={handleBumpChange}
          />
          <Select
            label="SPEED"
            options={[
              { value: '15', label: '15 ips' },
              { value: '7.5', label: '7.5 ips' },
              { value: '3.75', label: '3.75 ips' },
            ]}
            value={String(tapeSpeed)}
            onChange={handleSpeedChange}
          />
          <Select
            label="OS"
            options={[
              { value: '2', label: '2x' },
              { value: '4', label: '4x' },
            ]}
            value={String(oversample)}
            onChange={handleOversampleChange}
          />
        </div>
      </section>

      {/* Section 3: Output */}
      <section className="compact-section">
        <h3 className="compact-section__label">Output</h3>
        <div className="controls-row compact-controls-row compact-controls-row--5col">
          <Knob
            label="HISS" min={0} max={1} value={hiss}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('noise', 'hiss', v); }}
          />
          <Knob
            label="COLOR" min={-1} max={1} value={color} step={0.01}
            formatValue={fmtColor}
            onChange={(v) => { setStageParam('recordEQ', 'color', v); }}
          />
          <Knob
            label="HEADROOM" min={6} max={36} value={headroom} step={1}
            formatValue={fmtRef}
            onChange={(v) => { setHeadroom(v); }}
          />
          <Knob
            label="OUTPUT" min={0.25} max={16} value={outputGain}
            formatValue={fmtDb}
            onChange={(v) => { setStageParam('output', 'outputGain', v); }}
          />
          <div className="compact-button-control">
            <div className="select-label">Global</div>
            <ToggleButton
              label="BYPASS"
              className="bypass-btn"
              active={bypassed}
              onToggle={handleBypass}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
