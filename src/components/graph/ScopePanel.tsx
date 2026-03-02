import {
  useAudioEngine,
  SCOPE_STAGE_IDS,
  type ScopeStageId,
} from '../../stores/audio-engine';
import { STAGE_DEFS } from '../../types/stages';
import { Sparkline } from '../controls/Sparkline';

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

function ScopeRow({ stageId }: { stageId: ScopeStageId }) {
  const buffer = useAudioEngine((s) => s.scopeBuffers[stageId]);
  const cursor = useAudioEngine((s) => s.scopeBufferIndex);

  const levelData = buffer.map((s) => s.vuDb);
  const gainData = buffer.map((s) => s.gainDelta);
  const satData = buffer.map((s) => s.saturation);

  const label = STAGE_DEFS[stageId].label;

  return (
    <div className="scope-row">
      <span className="scope-row__label">{label}</span>
      <Sparkline data={levelData} cursor={cursor} min={-60} max={9} color={LEVEL_COLOR} formatTick={fmtDb} />
      <Sparkline data={gainData} cursor={cursor} min={-12} max={12} color="#6b88cc" zeroLine={0} formatTick={fmtDb} />
      <Sparkline data={satData} cursor={cursor} min={0} max={1} color={SATURATION_COLOR} formatTick={fmtPct} />
    </div>
  );
}

export function ScopePanel() {
  return (
    <div className="scope-panel">
      <div className="scope-panel__header">
        <span className="scope-panel__col-label">Level (dB)</span>
        <span className="scope-panel__col-label">Gain Delta (dB)</span>
        <span className="scope-panel__col-label">Saturation</span>
      </div>
      {SCOPE_STAGE_IDS.map((id) => (
        <ScopeRow key={id} stageId={id} />
      ))}
    </div>
  );
}
