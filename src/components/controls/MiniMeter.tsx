import { useMemo } from 'react';

interface MiniMeterProps {
  vuDb: number;
  peakDb: number;
  height?: number;
}

const DB_MIN = -60;
const DB_MAX = 9;
const DB_RANGE = DB_MAX - DB_MIN;

function dbToPct(db: number): number {
  return Math.max(0, Math.min(100, ((db - DB_MIN) / DB_RANGE) * 100));
}

export function MiniMeter({ vuDb, peakDb, height = 60 }: MiniMeterProps) {
  const vuPct = dbToPct(vuDb);
  const peakPct = dbToPct(peakDb);

  const fillColor = useMemo(() => {
    if (vuDb > 3) return '#ff4444';
    if (vuDb > 0) return '#ffcc00';
    return '#44cc44';
  }, [vuDb]);

  return (
    <div className="mini-meter" style={{ height }}>
      <div className="mini-meter__track">
        <div
          className="mini-meter__fill"
          style={{ height: `${vuPct}%`, backgroundColor: fillColor }}
        />
        {peakPct > 0 && (
          <div
            className="mini-meter__peak"
            style={{ bottom: `${peakPct}%` }}
          />
        )}
      </div>
    </div>
  );
}
