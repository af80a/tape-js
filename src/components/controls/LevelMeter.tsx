import { useMemo } from 'react';

interface LevelMeterProps {
  label: string;
  vuDb: number;
  peakDb: number;
}

export function LevelMeter({ label, vuDb, peakDb }: LevelMeterProps) {
  const vuPct = Math.max(0, Math.min(100, ((vuDb + 20) / 29) * 100));
  const peakPct = Math.max(0, Math.min(100, ((peakDb + 20) / 29) * 100));

  const fillColor = useMemo(() => {
    if (vuDb > 3) return '#ff4444';
    if (vuDb > 0) return '#ffcc00';
    return '#44cc44';
  }, [vuDb]);

  return (
    <div className="meter-container">
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div
          className="meter-fill"
          style={{ width: `${vuPct}%`, backgroundColor: fillColor }}
        />
        <div className="meter-peak" style={{ left: `${peakPct}%` }} />
      </div>
    </div>
  );
}
