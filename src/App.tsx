import { useState, useCallback, type DragEvent } from 'react';
import { useAudioEngine } from './stores/audio-engine';
import { useStageParams } from './stores/stage-params';
import { CompactView } from './components/compact/CompactView';
import { GraphView } from './components/graph/GraphView';
import { GraphHeaderControls } from './components/graph/GraphHeaderControls';
import { LevelMeter } from './components/controls/LevelMeter';
import { TransportBar } from './components/transport/TransportBar';

type ViewMode = 'compact' | 'graph';

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('compact');
  const [dragover, setDragover] = useState(false);

  const loadFile = useAudioEngine((s) => s.loadFile);
  const stageMeters = useAudioEngine((s) => s.stageMeters);
  const loadPreset = useStageParams((s) => s.loadPreset);

  const inVuDb = stageMeters.inputXfmr?.vuDb[0] ?? -60;
  const inPeakDb = stageMeters.inputXfmr?.peakDb[0] ?? -60;
  const outVuDb = stageMeters.output?.vuDb[1] ?? -60;
  const outPeakDb = stageMeters.output?.peakDb[1] ?? -60;

  const handleFileLoad = useCallback(
    (file: File) => { loadFile(file); },
    [loadFile],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragover(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragover(false), []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragover(false);
      const file = e.dataTransfer?.files[0];
      if (file) handleFileLoad(file);
    },
    [handleFileLoad],
  );

  const isGraph = viewMode === 'graph';

  return (
    <div
      className={`app-root ${isGraph ? 'app-root--graph' : ''} ${dragover ? 'dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <header className={`app-header ${isGraph ? 'app-header--graph' : ''}`}>
        <h1>TAPE SATURATOR</h1>
        <div className={`app-header__actions ${isGraph ? 'app-header__actions--graph' : ''}`}>
          <button
            className="btn"
            onClick={() => setViewMode(viewMode === 'compact' ? 'graph' : 'compact')}
          >
            {viewMode === 'compact' ? 'Graph View' : 'Compact View'}
          </button>
          {isGraph && <GraphHeaderControls />}
          <FileLoadButton onFileLoad={handleFileLoad} />
        </div>
      </header>

      {/* View */}
      {viewMode === 'compact' ? (
        <CompactView onPresetChange={loadPreset} />
      ) : (
        <GraphView />
      )}

      <div className={isGraph ? 'app-dock' : ''}>
        {/* Meters */}
        <div className="meters-row">
          <LevelMeter label="IN" vuDb={inVuDb} peakDb={inPeakDb} />
          <LevelMeter label="OUT" vuDb={outVuDb} peakDb={outPeakDb} />
        </div>

        {/* Transport */}
        <TransportBar />
      </div>
    </div>
  );
}

function FileLoadButton({ onFileLoad }: { onFileLoad: (file: File) => void }) {
  const handleClick = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) onFileLoad(file);
    };
    input.click();
  }, [onFileLoad]);

  return (
    <button className="btn" onClick={handleClick}>
      Load Audio
    </button>
  );
}
