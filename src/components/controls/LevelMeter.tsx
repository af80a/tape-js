interface LevelMeterProps {
  label: string;
  vuDb: number;
  peakDb: number;
}

const DB_TICKS = [
  { db: -12, label: '-12' },
  { db: -6, label: '-6' },
  { db: 0, label: '0' },
  { db: 3, label: '+3' },
  { db: 6, label: '+6' },
];

function dbToPct(db: number): number {
  return Math.max(0, Math.min(100, ((db + 20) / 29) * 100));
}

export function LevelMeter({ label, vuDb, peakDb }: LevelMeterProps) {
  const vuPct = dbToPct(vuDb);
  const peakPct = dbToPct(peakDb);

  return (
    <div className="meter-container">
      <span className="meter-label">{label}</span>
      <div className="meter-wrapper">
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${vuPct}%` }} />
          <div className="meter-peak" style={{ left: `${peakPct}%` }} />
          {DB_TICKS.map((t) => (
            <div
              key={t.db}
              className={`meter-tick${t.db === 0 ? ' meter-tick--zero' : ''}`}
              style={{ left: `${dbToPct(t.db)}%` }}
            />
          ))}
        </div>
        <div className="meter-scale">
          {DB_TICKS.map((t) => (
            <span
              key={t.db}
              className={`meter-scale__label${t.db === 0 ? ' meter-scale__label--zero' : ''}`}
              style={{ left: `${dbToPct(t.db)}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
