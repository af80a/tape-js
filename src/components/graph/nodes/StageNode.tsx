import { memo, useCallback, useState } from 'react';
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

  const [linked, setLinked] = useState(false);
  const hasInputGain = 'inputGain' in def.params;

  const handleBypass = useCallback(() => {
    setStageBypass(stageId, !state.bypassed);
  }, [stageId, state.bypassed, setStageBypass]);

  const handleVariantChange = useCallback(
    (v: string) => setStageVariant(stageId, v),
    [stageId, setStageVariant],
  );

  const handleParamChange = useCallback((key: string, v: number) => {
    if (linked && key === 'inputGain') {
      const inputGainDef = def.params['inputGain'];
      const prevGain = state.params['inputGain'] ?? inputGainDef.default;
      const deltaDb = 20 * Math.log10(v / prevGain);
      const prevTrim = state.params['_trim'] ?? 0;
      const newTrim = Math.max(-12, Math.min(12, prevTrim - deltaDb));
      setStageParam(stageId, '_trim', newTrim);
    }
    setStageParam(stageId, key, v);
  }, [linked, stageId, state.params, def.params, setStageParam]);

  const paramEntries = Object.entries(def.params);

  return (
    <div className={`stage-node ${state.bypassed ? 'stage-node--bypassed' : ''}`}>
      <Handle type="target" position={Position.Left} id="target-left" />
      <Handle type="source" position={Position.Left} id="source-left" />
      <Handle type="target" position={Position.Top} id="target-top" />

      {/* Header */}
      <div className="stage-node__header">
        <span className="stage-node__title">{label}</span>
        <div className="stage-node__header-buttons">
          {hasInputGain && (
            <button
              className={`stage-node__link nopan nodrag ${linked ? 'stage-node__link--active' : ''}`}
              onClick={() => setLinked((l) => !l)}
              title="Link input gain to trim — moving Input compensates Trim to keep level constant"
            >
              LNK
            </button>
          )}
          <button
            className={`stage-node__bypass nopan nodrag ${state.bypassed ? 'stage-node__bypass--active' : ''}`}
            onClick={handleBypass}
          >
            BYP
          </button>
        </div>
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
                  onChange={(v) => handleParamChange(key, v)}
                />
            ))}
          </div>
        </div>

        <div className="stage-node__meter">
          <MiniMeter vuDb={meterLevels?.vuDb[1] ?? -60} peakDb={meterLevels?.peakDb[1] ?? -60} />
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="source-right" />
      <Handle type="target" position={Position.Right} id="target-right" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" />
    </div>
  );
});
