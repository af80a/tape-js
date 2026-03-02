import { useState } from 'react';
import {
  useAudioEngine,
  SCOPE_STAGE_IDS,
  type ScopeStageId,
} from '../../stores/audio-engine';
import { STAGE_DEFS } from '../../types/stages';
import { Sparkline } from '../controls/Sparkline';

// Preset spans per column. Each entry is [span, center].
// Visible range = [center - span/2, center + span/2].
const LEVEL_PRESETS = [72, 36, 18, 9].map((span) => {
  const center = -12;
  return { min: center - span / 2, max: center + span / 2, label: `${span} dB` };
});

const GAIN_PRESETS = [48, 24, 12, 6, 3].map((span) => {
  const center = 0;
  return { min: center - span / 2, max: center + span / 2, label: `±${span / 2} dB` };
});

// Saturation baseline is always 0 — zoom shrinks the ceiling, not the center.
const SAT_PRESETS = [1.0, 0.75, 0.5, 0.25].map((max) => ({
  min: 0,
  max,
  label: `${Math.round(max * 100)}%`,
}));

const LEVEL_COLOR = (v: number) => {
  if (v > 3) return '#ff4444';
  if (v > 0) return '#ffcc00';
  return '#44cc44';
};

const SATURATION_COLOR = (v: number) => {
  if (v > 0.7) return '#ff4444';
  if (v > 0.3) return '#ffcc00';
  return '#5f8f8a';
};

const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v}`;
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

interface ScaleHeaderProps {
  label: string;
  presets: { min: number; max: number; label: string }[];
  index: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

function ScaleHeader({ label, presets, index, onZoomIn, onZoomOut }: ScaleHeaderProps) {
  return (
    <div className="scope-panel__col-header">
      <span className="scope-panel__col-label">{label}</span>
      <div className="scope-panel__scale-controls">
        <button
          className="scope-panel__scale-btn"
          onClick={onZoomOut}
          disabled={index === 0}
          aria-label="Zoom out"
        >
          –
        </button>
        <span className="scope-panel__scale-label">{presets[index].label}</span>
        <button
          className="scope-panel__scale-btn"
          onClick={onZoomIn}
          disabled={index === presets.length - 1}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
    </div>
  );
}

interface ScopeRowProps {
  stageId: ScopeStageId;
  levelMin: number;
  levelMax: number;
  gainMin: number;
  gainMax: number;
  satMin: number;
  satMax: number;
}

function ScopeRow({ stageId, levelMin, levelMax, gainMin, gainMax, satMin, satMax }: ScopeRowProps) {
  const buffer = useAudioEngine((s) => s.scopeBuffers[stageId]);
  const cursor = useAudioEngine((s) => s.scopeBufferIndex);

  const levelData = buffer.map((s) => s.vuDb);
  const gainData = buffer.map((s) => s.gainDelta);
  const satData = buffer.map((s) => s.saturation);

  const label = STAGE_DEFS[stageId].label;

  return (
    <div className="scope-row">
      <span className="scope-row__label">{label}</span>
      <Sparkline data={levelData} cursor={cursor} min={levelMin} max={levelMax} color={LEVEL_COLOR} formatTick={fmtDb} />
      <Sparkline data={gainData} cursor={cursor} min={gainMin} max={gainMax} color="#6b88cc" zeroLine={0} formatTick={fmtDb} />
      <Sparkline data={satData} cursor={cursor} min={satMin} max={satMax} color={SATURATION_COLOR} formatTick={fmtPct} />
    </div>
  );
}

export function ScopePanel() {
  const [levelIdx, setLevelIdx] = useState(1);   // default: 36 dB span
  const [gainIdx, setGainIdx] = useState(1);     // default: ±12 dB
  const [satIdx, setSatIdx] = useState(0);       // default: full 0..1

  const levelRange = LEVEL_PRESETS[levelIdx];
  const gainRange = GAIN_PRESETS[gainIdx];
  const satRange = SAT_PRESETS[satIdx];

  return (
    <div className="scope-panel">
      <div className="scope-panel__header">
        <ScaleHeader
          label="Level (dB)"
          presets={LEVEL_PRESETS}
          index={levelIdx}
          onZoomIn={() => setLevelIdx((i) => Math.min(i + 1, LEVEL_PRESETS.length - 1))}
          onZoomOut={() => setLevelIdx((i) => Math.max(i - 1, 0))}
        />
        <ScaleHeader
          label="Gain Delta (dB)"
          presets={GAIN_PRESETS}
          index={gainIdx}
          onZoomIn={() => setGainIdx((i) => Math.min(i + 1, GAIN_PRESETS.length - 1))}
          onZoomOut={() => setGainIdx((i) => Math.max(i - 1, 0))}
        />
        <ScaleHeader
          label="Saturation"
          presets={SAT_PRESETS}
          index={satIdx}
          onZoomIn={() => setSatIdx((i) => Math.min(i + 1, SAT_PRESETS.length - 1))}
          onZoomOut={() => setSatIdx((i) => Math.max(i - 1, 0))}
        />
      </div>
      {SCOPE_STAGE_IDS.map((id) => (
        <ScopeRow
          key={id}
          stageId={id}
          levelMin={levelRange.min}
          levelMax={levelRange.max}
          gainMin={gainRange.min}
          gainMax={gainRange.max}
          satMin={satRange.min}
          satMax={satRange.max}
        />
      ))}
    </div>
  );
}
