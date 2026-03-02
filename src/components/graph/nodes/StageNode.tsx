import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { type StageId, type StageDef } from '../../../types/stages';
import { useStageParams } from '../../../stores/stage-params';
import { useAudioEngine } from '../../../stores/audio-engine';
import { Knob } from '../../controls/Knob';
import { Select } from '../../controls/Select';
import { MiniMeter } from '../../controls/MiniMeter';

interface StageNodeData {
  stageId: StageId;
  label: string;
  def: StageDef;
  [key: string]: unknown;
}

export const StageNode = memo(function StageNode({ data }: NodeProps) {
  const { stageId, label, def } = data as unknown as StageNodeData;

  // Read live state from store so bypass/params stay reactive
  const state = useStageParams((s) => s.stages[stageId]);
  const setStageBypass = useStageParams((s) => s.setStageBypass);
  const setStageVariant = useStageParams((s) => s.setStageVariant);
  const setStageParam = useStageParams((s) => s.setStageParam);

  // Per-stage meter levels: [input, output]
  const meterLevels = useAudioEngine((s) => s.stageMeters[stageId]);

  const handleBypass = useCallback(() => {
    setStageBypass(stageId, !state.bypassed);
  }, [stageId, state.bypassed, setStageBypass]);

  const handleVariantChange = useCallback(
    (v: string) => setStageVariant(stageId, v),
    [stageId, setStageVariant],
  );

  const paramEntries = Object.entries(def.params);

  return (
    <div className={`stage-node ${state.bypassed ? 'stage-node--bypassed' : ''}`}>
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />

      {/* Header */}
      <div className="stage-node__header">
        <span className="stage-node__title">{label}</span>
        <button
          className={`stage-node__bypass nopan nodrag ${state.bypassed ? 'stage-node__bypass--active' : ''}`}
          onClick={handleBypass}
        >
          BYP
        </button>
      </div>

      {/* Content row: input meter | body | output meter */}
      <div className="stage-node__content">
        <div className="stage-node__meter">
          <MiniMeter vuDb={meterLevels?.vuDb[0] ?? -60} peakDb={meterLevels?.peakDb[0] ?? -60} />
        </div>

        {/* Body — nopan/nodrag so knobs and selects capture mouse events */}
        <div className="stage-node__body nopan nodrag">
          {/* Variant selector */}
          {def.variants && (
            <Select
              label="Type"
              options={def.variants}
              value={state.variant ?? def.variants[0].value}
              onChange={handleVariantChange}
            />
          )}

          {/* Parameter knobs */}
          <div className="stage-node__params">
            {paramEntries
              .filter(([, paramDef]) => !paramDef.tubeOnly || state.variant === 'tube')
              .map(([key, paramDef]) => (
                <Knob
                  key={key}
                  label={paramDef.label}
                  min={paramDef.min}
                  max={paramDef.max}
                  value={state.params[key] ?? paramDef.default}
                  step={paramDef.step}
                  formatValue={paramDef.formatValue}
                  onChange={(v) => setStageParam(stageId, key, v)}
                />
            ))}
          </div>
        </div>

        <div className="stage-node__meter">
          <MiniMeter vuDb={meterLevels?.vuDb[1] ?? -60} peakDb={meterLevels?.peakDb[1] ?? -60} />
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
    </div>
  );
});
