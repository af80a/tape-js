import { useCallback } from 'react';
import { useAudioEngine } from '../../stores/audio-engine';

function fmtTime(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
      <path d="M4.5 2.5l9 5.5-9 5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
      <rect x="3" y="2.5" width="3.5" height="11" rx="0.8" />
      <rect x="9.5" y="2.5" width="3.5" height="11" rx="0.8" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
      <rect x="3" y="3" width="10" height="10" rx="1.2" />
    </svg>
  );
}

export function TransportBar() {
  const play = useAudioEngine((s) => s.play);
  const pause = useAudioEngine((s) => s.pause);
  const stop = useAudioEngine((s) => s.stop);
  const seek = useAudioEngine((s) => s.seek);
  const processOffline16x = useAudioEngine((s) => s.processOffline16x);
  const offlineProcessing = useAudioEngine((s) => s.offlineProcessing);
  const offlineProgress = useAudioEngine((s) => s.offlineProgress);
  const currentTime = useAudioEngine((s) => s.currentTime);
  const duration = useAudioEngine((s) => s.duration);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      seek(parseFloat(e.target.value));
    },
    [seek],
  );

  return (
    <div className="transport">
      <button className="btn transport-btn" onClick={play} aria-label="Play">
        <PlayIcon />
      </button>
      <button className="btn transport-btn" onClick={pause} aria-label="Pause">
        <PauseIcon />
      </button>
      <button className="btn transport-btn" onClick={stop} aria-label="Stop">
        <StopIcon />
      </button>
      <button
        className="btn transport-process-btn"
        onClick={() => { void processOffline16x(); }}
        disabled={offlineProcessing || duration <= 0}
      >
        {offlineProcessing ? `Processing ${Math.round(offlineProgress * 100)}%` : 'Process'}
      </button>
      <input
        type="range"
        className="seek-bar"
        min="0"
        max={duration}
        step="0.01"
        value={currentTime}
        onChange={handleSeek}
      />
      <div className="time-display">
        {fmtTime(currentTime)}<span className="time-sep"> / </span>{fmtTime(duration)}
      </div>
    </div>
  );
}
