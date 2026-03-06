import { useAudioEngine } from '../../stores/audio-engine';
import { useStageParams } from '../../stores/stage-params';
import { Knob } from '../controls/Knob';
import { Select } from '../controls/Select';
import { ToggleButton } from '../controls/ToggleButton';
import { FORMULAS } from '../../dsp/presets';
import {
  alignmentToAzimuth,
  applyLinkedGainTrimDelta,
  applyGroupedDelta,
  azimuthToAlignment,
  resolveGroupedNumberState,
  resolveGroupedVariantValue,
} from './compact-macros';

const BUMP_PROFILES = [
  { key: 'flat' as const, gainDb: 0 },
  { key: 'subtle' as const, gainDb: 1.5 },
  { key: 'massive' as const, gainDb: 3.5 },
];

const MACHINE_OPTIONS = [
  { value: 'studer', label: 'Studer A810' },
  { value: 'ampex', label: 'Ampex ATR-102' },
  { value: 'mci', label: 'MCI JH-24' },
];

const FORMULA_OPTIONS = [
  { value: '456', label: 'Ampex 456' },
  { value: '499', label: 'Quantegy 499' },
  { value: '900', label: 'BASF 900' },
];

const MIXED_AMP_TYPE = '__mixed__';

const AMP_TYPE_OPTIONS = [
  { value: MIXED_AMP_TYPE, label: 'Mixed', disabled: true },
  { value: 'transistor', label: 'Solid State' },
  { value: 'tube', label: 'Tube 12AX7' },
];

const BUMP_OPTIONS = [
  { value: 'flat', label: 'Flat (0dB)' },
  { value: 'subtle', label: 'Subtle (+1.5dB)' },
  { value: 'massive', label: 'Massive (+3.5dB)' },
];

const SPEED_OPTIONS = [
  { value: '30', label: '30 ips' },
  { value: '15', label: '15 ips' },
  { value: '7.5', label: '7.5 ips' },
  { value: '3.75', label: '3.75 ips' },
];

const OVERSAMPLE_OPTIONS = [
  { value: '2', label: '2x' },
  { value: '4', label: '4x' },
];

const INPUT_ALIGN_OPTIONS = [
  { value: 'mix', label: 'Mix' },
  { value: 'track', label: 'Track' },
  { value: 'drums', label: 'Drums' },
  { value: 'bass', label: 'Bass' },
];

function fmtDb(v: number): string {
  const db = 20 * Math.log10(v);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtIron(v: number): string {
  return `${v.toFixed(2)}x`;
}

function fmtAlign(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtRef(v: number): string {
  return `${v.toFixed(0)} dB`;
}

function fmtMultiplier(v: number): string {
  return `${v.toFixed(2)}x`;
}

function fmtColor(v: number): string {
  if (v < -0.01) return `Dark ${Math.round(Math.abs(v) * 100)}%`;
  if (v > 0.01) return `Bright ${Math.round(v * 100)}%`;
  return 'Neutral';
}

function bumpProfileFromGain(gainDb: number): 'flat' | 'subtle' | 'massive' {
  return BUMP_PROFILES.reduce((best, next) =>
    Math.abs(next.gainDb - gainDb) < Math.abs(best.gainDb - gainDb) ? next : best
  ).key;
}

function bumpGainFromProfile(profile: string): number {
  return BUMP_PROFILES.find((entry) => entry.key === profile)?.gainDb ?? 3.5;
}

interface CompactViewProps {
  onPresetChange: (preset: string) => void;
}

export function CompactView({ onPresetChange }: CompactViewProps) {
  const bypassed = useAudioEngine((s) => s.globalBypassed);
  const tapeSpeed = useAudioEngine((s) => s.tapeSpeed);
  const oversample = useAudioEngine((s) => s.oversample);
  const couplingAmount = useAudioEngine((s) => s.couplingAmount);
  const recordCouplingMode = useAudioEngine((s) => s.recordCouplingMode);
  const inputAlignMode = useAudioEngine((s) => s.inputAlignMode);
  const formula = useAudioEngine((s) => s.formula);
  const stages = useStageParams((s) => s.stages);
  const setGlobalBypass = useAudioEngine((s) => s.setGlobalBypass);
  const setHeadroom = useAudioEngine((s) => s.setHeadroom);
  const setTapeSpeed = useAudioEngine((s) => s.setTapeSpeed);
  const setOversample = useAudioEngine((s) => s.setOversample);
  const setCouplingAmount = useAudioEngine((s) => s.setCouplingAmount);
  const setRecordCouplingMode = useAudioEngine((s) => s.setRecordCouplingMode);
  const setInputAlignMode = useAudioEngine((s) => s.setInputAlignMode);
  const setFormula = useAudioEngine((s) => s.setFormula);
  const setAmpType = useStageParams((s) => s.setAmpType);
  const headroom = useAudioEngine((s) => s.headroom);
  const preset = useStageParams((s) => s.currentPreset);
  const setStageParam = useStageParams((s) => s.setStageParam);
  const inputGain = stages.inputXfmr.params.inputGain ?? 1.0;
  const outputPushGain = stages.outputXfmr.params.inputGain ?? 1.0;
  const inputTrim = stages.inputXfmr.params._trim ?? 0;
  const outputTrim = stages.outputXfmr.params._trim ?? 0;
  const inputIron = stages.inputXfmr.params.satAmount ?? 1.0;
  const outputIron = stages.outputXfmr.params.satAmount ?? 1.0;
  const alignment = azimuthToAlignment(stages.head.params.azimuth ?? 1.0);
  const bleed = stages.head.params.crosstalk ?? 0.006;
  const wear = stages.head.params.dropouts ?? 0.0;
  const biasLevel = stages.bias.params.level ?? 0.5;
  const hysteresisSaturation = stages.hysteresis.params.saturation ?? 0.5;
  const hysteresisDrive = stages.hysteresis.params.drive ?? 0.5;
  const recordAmpDrive = stages.recordAmp.params.drive ?? 0.5;
  const playbackAmpDrive = stages.playbackAmp.params.drive ?? 0.4;
  const wow = stages.transport.params.wow ?? 0.15;
  const flutter = stages.transport.params.flutter ?? 0.1;
  const hiss = stages.noise.params.hiss ?? 0.05;
  const color = stages.recordEQ.params.color ?? 0;
  const outputGain = stages.output.params.outputGain ?? 1.0;
  const headBump = stages.head.params.bumpGainDb ?? 0;
  const bump = bumpProfileFromGain(headBump);
  const ampType = resolveGroupedVariantValue([stages.recordAmp.variant, stages.playbackAmp.variant], MIXED_AMP_TYPE);
  const pushState = resolveGroupedNumberState([inputGain, outputPushGain]);
  const ironState = resolveGroupedNumberState([inputIron, outputIron]);
  const ampDriveState = resolveGroupedNumberState([recordAmpDrive, playbackAmpDrive]);

  const handleFormulaChange = (value: string) => {
    setFormula(value);
    const f = FORMULAS[value];
    if (f) {
      setStageParam('hysteresis', 'k', f.k);
      setStageParam('hysteresis', 'c', f.c);
    }
  };

  const handleAmpDriveChange = (value: number) => {
    const [nextRecordDrive, nextPlaybackDrive] = applyGroupedDelta(
      [recordAmpDrive, playbackAmpDrive],
      value,
      0,
      1,
    );
    setStageParam('recordAmp', 'drive', nextRecordDrive);
    setStageParam('playbackAmp', 'drive', nextPlaybackDrive);
  };

  const handleIronChange = (value: number) => {
    const [nextInputIron, nextOutputIron] = applyGroupedDelta(
      [inputIron, outputIron],
      value,
      0,
      2,
    );
    setStageParam('inputXfmr', 'satAmount', nextInputIron);
    setStageParam('outputXfmr', 'satAmount', nextOutputIron);
  };

  const handlePushChange = (value: number) => {
    const { gains, trims } = applyLinkedGainTrimDelta(
      [inputGain, outputPushGain],
      [inputTrim, outputTrim],
      value,
      0.25,
      4,
      -12,
      12,
    );
    setStageParam('inputXfmr', 'inputGain', gains[0]);
    setStageParam('inputXfmr', '_trim', trims[0]);
    setStageParam('outputXfmr', 'inputGain', gains[1]);
    setStageParam('outputXfmr', '_trim', trims[1]);
  };

  const handleAlignmentChange = (value: number) => {
    setStageParam('head', 'azimuth', alignmentToAzimuth(value));
  };

  return (
    <div className="compact-controls">
      {/* Section 1: Character */}
      <section className="compact-section">
        <h3 className="compact-section__label">Character</h3>
        <div className="controls-row compact-controls-row compact-controls-row--9col">
          <Knob
            label="INPUT" min={0.25} max={4} value={inputGain}
            formatValue={fmtDb}
            onChange={(v) => { setStageParam('inputXfmr', 'inputGain', v); }}
          />
          <Knob
            label="PUSH" min={0.25} max={4} value={pushState.value}
            formatValue={fmtDb}
            displayValue={pushState.mixed ? `Mixed ${fmtDb(pushState.value)}` : undefined}
            onChange={handlePushChange}
          />
          <Knob
            label="IRON" min={0} max={2} value={ironState.value}
            formatValue={fmtIron}
            onChange={handleIronChange}
          />
          <Knob
            label="BIAS" min={0} max={1} value={biasLevel}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('bias', 'level', v); }}
          />
          <Knob
            label="SAT" min={0} max={1} value={hysteresisSaturation}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('hysteresis', 'saturation', v); }}
          />
          <Knob
            label="DRIVE" min={0} max={1} value={hysteresisDrive}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('hysteresis', 'drive', v); }}
          />
          <Knob
            label="AMP" min={0} max={1} value={ampDriveState.value}
            formatValue={fmtPct}
            displayValue={ampDriveState.mixed ? `Mixed ${fmtPct(ampDriveState.value)}` : undefined}
            onChange={handleAmpDriveChange}
          />
          <Knob
            label="WOW" min={0} max={1} value={wow}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('transport', 'wow', v); }}
          />
          <Knob
            label="FLUTTER" min={0} max={1} value={flutter}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('transport', 'flutter', v); }}
          />
        </div>
      </section>

      {/* Section 2: Machine */}
      <section className="compact-section">
        <h3 className="compact-section__label">Machine</h3>
        <div className="controls-row compact-controls-row compact-controls-row--9col">
          <Select
            label="MACHINE"
            options={MACHINE_OPTIONS}
            value={preset}
            onChange={onPresetChange}
          />
          <Select
            label="FORMULA"
            options={FORMULA_OPTIONS}
            value={formula}
            onChange={handleFormulaChange}
          />
          <Select
            label="AMP TYPE"
            options={AMP_TYPE_OPTIONS}
            value={ampType}
            onChange={(value) => {
              if (value !== MIXED_AMP_TYPE) {
                setAmpType(value as 'tube' | 'transistor');
              }
            }}
          />
          <Select
            label="BUMP"
            options={BUMP_OPTIONS}
            value={bump}
            onChange={(value) => { setStageParam('head', 'bumpGainDb', bumpGainFromProfile(value)); }}
          />
          <Select
            label="SPEED"
            options={SPEED_OPTIONS}
            value={String(tapeSpeed)}
            onChange={(value) => { setTapeSpeed(parseFloat(value)); }}
          />
          <Select
            label="OS"
            options={OVERSAMPLE_OPTIONS}
            value={String(oversample)}
            onChange={(value) => { setOversample(parseInt(value, 10)); }}
          />
          <Select
            label="AUTO IN"
            options={INPUT_ALIGN_OPTIONS}
            value={inputAlignMode}
            onChange={(value) => { setInputAlignMode(value as 'mix' | 'track' | 'drums' | 'bass'); }}
          />
          <Knob
            label="COUPLING" min={0.25} max={3} step={0.01} value={couplingAmount}
            formatValue={fmtMultiplier}
            onChange={(v) => { setCouplingAmount(v); }}
          />
          <div className="compact-button-control">
            <div className="select-label">Coupling</div>
            <ToggleButton
              label="PREDICT"
              active={recordCouplingMode === 'predictor'}
              onToggle={(active) => { setRecordCouplingMode(active ? 'predictor' : 'delayed'); }}
            />
          </div>
        </div>
      </section>

      {/* Section 3: Output */}
      <section className="compact-section">
        <h3 className="compact-section__label">Texture</h3>
        <div className="controls-row compact-controls-row compact-controls-row--5col">
          <Knob
            label="ALIGN" min={0} max={1} value={alignment}
            formatValue={fmtAlign}
            onChange={handleAlignmentChange}
          />
          <Knob
            label="BLEED" min={0} max={0.25} value={bleed} step={0.001}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('head', 'crosstalk', v); }}
          />
          <Knob
            label="WEAR" min={0} max={1} value={wear} step={0.01}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('head', 'dropouts', v); }}
          />
          <Knob
            label="HISS" min={0} max={1} value={hiss}
            formatValue={fmtPct}
            onChange={(v) => { setStageParam('noise', 'hiss', v); }}
          />
          <Knob
            label="COLOR" min={-1} max={1} value={color} step={0.01}
            formatValue={fmtColor}
            onChange={(v) => { setStageParam('recordEQ', 'color', v); }}
          />
        </div>
      </section>

      {/* Section 4: Output */}
      <section className="compact-section">
        <h3 className="compact-section__label">Output</h3>
        <div className="controls-row compact-controls-row compact-controls-row--3col">
          <Knob
            label="HEADROOM" min={6} max={36} value={headroom} step={1}
            formatValue={fmtRef}
            onChange={(v) => { setHeadroom(v); }}
          />
          <Knob
            label="OUTPUT" min={0.25} max={16} value={outputGain}
            formatValue={fmtDb}
            onChange={(v) => { setStageParam('output', 'outputGain', v); }}
          />
          <div className="compact-button-control">
            <div className="select-label">Global</div>
            <ToggleButton
              label="BYPASS"
              className="bypass-btn"
              active={bypassed}
              onToggle={setGlobalBypass}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
