import { useCallback } from 'react';
import { ToggleButton } from '../controls/ToggleButton';
import { Select } from '../controls/Select';
import { useAudioEngine } from '../../stores/audio-engine';
import { useStageParams } from '../../stores/stage-params';

export function GraphHeaderControls() {
  const bypassed = useAudioEngine((s) => s.globalBypassed);
  const tapeSpeed = useAudioEngine((s) => s.tapeSpeed);
  const oversample = useAudioEngine((s) => s.oversample);
  const setGlobalBypass = useAudioEngine((s) => s.setGlobalBypass);
  const setTapeSpeed = useAudioEngine((s) => s.setTapeSpeed);
  const setOversample = useAudioEngine((s) => s.setOversample);
  const scopeOpen = useAudioEngine((s) => s.scopeOpen);
  const toggleScope = useAudioEngine((s) => s.toggleScope);
  const preset = useStageParams((s) => s.currentPreset);
  const loadPreset = useStageParams((s) => s.loadPreset);
  const headroom = useAudioEngine((s) => s.headroom);
  const setHeadroom = useAudioEngine((s) => s.setHeadroom);

  const handleBypass = useCallback(
    (v: boolean) => setGlobalBypass(v),
    [setGlobalBypass],
  );
  const handlePresetChange = useCallback(
    (v: string) => loadPreset(v),
    [loadPreset],
  );
  const handleSpeedChange = useCallback(
    (v: string) => setTapeSpeed(parseFloat(v)),
    [setTapeSpeed],
  );
  const handleOversampleChange = useCallback(
    (v: string) => setOversample(parseInt(v, 10)),
    [setOversample],
  );
  const handleHeadroomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setHeadroom(parseFloat(e.target.value)),
    [setHeadroom],
  );

  return (
    <div className="graph-header-controls">
      {/* Machine group */}
      <div className="graph-header-controls__group">
        <Select
          label="Machine"
          options={[
            { value: 'studer', label: 'Studer A810' },
            { value: 'ampex', label: 'Ampex ATR-102' },
            { value: 'mci', label: 'MCI JH-24' },
          ]}
          value={preset}
          onChange={handlePresetChange}
        />
        <Select
          label="Speed"
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

      <div className="graph-header-controls__divider" />

      {/* Headroom group */}
      <div className="graph-header-controls__group graph-header-controls__headroom">
        <span className="headroom-label">HEADROOM</span>
        <input
          type="range"
          min="6"
          max="36"
          step="1"
          value={headroom}
          onChange={handleHeadroomChange}
          title={`Headroom: -${headroom} dBFS`}
        />
        <span className="headroom-value">{-headroom}</span>
      </div>

      <div className="graph-header-controls__divider" />

      {/* Status group */}
      <div className="graph-header-controls__group">
        <ToggleButton
          label="BYPASS"
          className="bypass-btn graph-header-controls__bypass"
          active={bypassed}
          onToggle={handleBypass}
        />
        <ToggleButton
          label="SCOPE"
          className="scope-btn"
          active={scopeOpen}
          onToggle={toggleScope}
        />
      </div>
    </div>
  );
}
