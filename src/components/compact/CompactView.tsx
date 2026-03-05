import { useCallback } from 'react';
import { useAudioEngine } from '../../stores/audio-engine';
import { useStageParams } from '../../stores/stage-params';
import { Knob } from '../controls/Knob';
import { Select } from '../controls/Select';
import { ToggleButton } from '../controls/ToggleButton';

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

interface CompactViewProps {
  onPresetChange: (preset: string) => void;
}

export function CompactView({ onPresetChange }: CompactViewProps) {
  const setParam = useAudioEngine((s) => s.setParam);
  const bypassed = useAudioEngine((s) => s.globalBypassed);
  const tapeSpeed = useAudioEngine((s) => s.tapeSpeed);
  const oversample = useAudioEngine((s) => s.oversample);
  const formula = useAudioEngine((s) => s.formula);
  const ampType = useStageParams((s) => s.stages.recordAmp.variant) as 'tube' | 'transistor';
  const bump = useAudioEngine((s) => s.bump);
  const setGlobalBypass = useAudioEngine((s) => s.setGlobalBypass);
  const setHeadroom = useAudioEngine((s) => s.setHeadroom);
  const setTapeSpeed = useAudioEngine((s) => s.setTapeSpeed);
  const setOversample = useAudioEngine((s) => s.setOversample);
  const setFormula = useAudioEngine((s) => s.setFormula);
  const setAmpType = useStageParams((s) => s.setAmpType);
  const setBump = useAudioEngine((s) => s.setBump);
  const postMessage = useAudioEngine((s) => s.postMessage);
  const preset = useStageParams((s) => s.currentPreset);
  const setStageParam = useStageParams((s) => s.setStageParam);

  // Clear graph-view overrides each time a compact knob is touched,
  // so AudioParam values take effect in the worklet.
  const clearOverrides = useCallback(() => {
    postMessage({ type: 'clear-param-overrides' });
  }, [postMessage]);

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
    },
    [setFormula],
  );

  const handleAmpTypeChange = useCallback(
    (v: string) => {
      setAmpType(v as 'tube' | 'transistor');
    },
    [setAmpType],
  );

  const handleBumpChange = useCallback(
    (v: string) => {
      setBump(v);
    },
    [setBump],
  );

  return (
    <div className="compact-controls">
      {/* Section 1: Character */}
      <section className="compact-section">
        <h3 className="compact-section__label">Character</h3>
        <div className="controls-row compact-controls-row">
          <Knob
            label="INPUT" min={0.25} max={4} value={1}
            formatValue={fmtDb}
            onChange={(v) => { clearOverrides(); setParam('inputGain', v); }}
          />
          <Knob
            label="BIAS" min={0} max={1} value={0.5}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('bias', v); }}
          />
          <Knob
            label="SAT" min={0} max={1} value={0.5}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('saturation', v); }}
          />
          <Knob
            label="DRIVE" min={0} max={1} value={0.5}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('drive', v); }}
          />
          <Knob
            label="AMP" min={0} max={1} value={0.5}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('ampDrive', v); }}
          />
          <Knob
            label="WOW" min={0} max={1} value={0.15}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('wow', v); }}
          />
          <Knob
            label="FLUTTER" min={0} max={1} value={0.1}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('flutter', v); }}
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
            label="HISS" min={0} max={1} value={0.05}
            formatValue={fmtPct}
            onChange={(v) => { clearOverrides(); setParam('hiss', v); }}
          />
          <Knob
            label="COLOR" min={-1} max={1} value={0} step={0.01}
            formatValue={fmtColor}
            onChange={(v) => { clearOverrides(); setParam('color', v); }}
          />
          <Knob
            label="HEADROOM" min={6} max={36} value={18} step={1}
            formatValue={fmtRef}
            onChange={(v) => { clearOverrides(); setHeadroom(v); }}
          />
          <Knob
            label="OUTPUT" min={0.25} max={16} value={1}
            formatValue={fmtDb}
            onChange={(v) => { clearOverrides(); setParam('outputGain', v); }}
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
