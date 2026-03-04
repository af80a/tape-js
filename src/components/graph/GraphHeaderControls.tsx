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

  const headroom = useAudioEngine((s) => s.headroom);
  const setHeadroom = useAudioEngine((s) => s.setHeadroom);

  const handleHeadroomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setHeadroom(parseFloat(e.target.value)),
    [setHeadroom]
  );

  return (
    <div className="graph-header-controls">
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
          { value: '8', label: '8x' },
        ]}
        value={String(oversample)}
        onChange={handleOversampleChange}
      />
      <div className="graph-header-controls__headroom">
        <span className="select-label">HEADROOM</span>
        <input 
          type="range" 
          min="6" 
          max="36" 
          step="1" 
          value={headroom} 
          onChange={handleHeadroomChange} 
          title={`Headroom: -${headroom} dBFS`}
        />
        <span className="headroom-value">-{headroom}</span>
      </div>
      <ToggleButton
        label="GLOBAL BYPASS"
        className="bypass-btn graph-header-controls__bypass"
        active={bypassed}
        onToggle={handleBypass}
      />
      <ToggleButton
        label="SCOPE"
        className="bypass-btn graph-header-controls__scope"
        active={scopeOpen}
        onToggle={toggleScope}
      />
    </div>
  );
}
