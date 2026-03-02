import { useCallback } from 'react';
import { useAudioEngine } from '../../stores/audio-engine';

function fmtTime(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export function TransportBar() {
  const play = useAudioEngine((s) => s.play);
  const pause = useAudioEngine((s) => s.pause);
  const stop = useAudioEngine((s) => s.stop);
  const seek = useAudioEngine((s) => s.seek);
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
      <button className="btn transport-btn" onClick={play}>
        Play
      </button>
      <button className="btn transport-btn" onClick={pause}>
        Pause
      </button>
      <button className="btn transport-btn" onClick={stop}>
        Stop
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
        {fmtTime(currentTime)} / {fmtTime(duration)}
      </div>
    </div>
  );
}
