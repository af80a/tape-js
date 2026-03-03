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

interface CompactViewProps {
  onPresetChange: (preset: string) => void;
}

export function CompactView({ onPresetChange }: CompactViewProps) {
  const setParam = useAudioEngine((s) => s.setParam);
  const bypassed = useAudioEngine((s) => s.globalBypassed);
  const tapeSpeed = useAudioEngine((s) => s.tapeSpeed);
  const oversample = useAudioEngine((s) => s.oversample);
  const setGlobalBypass = useAudioEngine((s) => s.setGlobalBypass);
  const setTapeSpeed = useAudioEngine((s) => s.setTapeSpeed);
  const setOversample = useAudioEngine((s) => s.setOversample);
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

  return (
    <div className="compact-controls">
      {/* Controls row 1 */}
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

      {/* Controls row 2 */}
      <div className="controls-row compact-controls-row">
        <Knob
          label="HISS" min={0} max={1} value={0.05}
          formatValue={fmtPct}
          onChange={(v) => { clearOverrides(); setParam('hiss', v); }}
        />
        <Knob
          label="OUTPUT" min={0.25} max={4} value={1}
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
    </div>
  );
}
