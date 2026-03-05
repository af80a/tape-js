import { useRef, useCallback, useEffect, useState } from 'react';

const SENSITIVITY = 0.003;
const FINE_SENSITIVITY = 0.0005;

interface KnobProps {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  formatValue?: (v: number) => string;
  onChange: (v: number) => void;
}

// Arc geometry constants
const SIZE = 56;
const CX = SIZE / 2;
const CY = SIZE / 2;
const ARC_R = 23;
const BODY_R = 16;
const DOT_R = 2.5;
const START_ANGLE = -135;
const ARC_SPAN = 270;

function toXY(angleDeg: number, r: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CX + r * Math.sin(rad),
    y: CY - r * Math.cos(rad),
  };
}

// Precompute static arc endpoints
const arcStart = toXY(START_ANGLE, ARC_R);
const arcEnd = toXY(START_ANGLE + ARC_SPAN, ARC_R);
const trackPath = `M${arcStart.x.toFixed(2)},${arcStart.y.toFixed(2)} A${ARC_R},${ARC_R} 0 1 1 ${arcEnd.x.toFixed(2)},${arcEnd.y.toFixed(2)}`;

export function Knob({ label, min, max, value, step = 0, formatValue, onChange }: KnobProps) {
  const defaultValueRef = useRef(value);
  const [internalValue, setInternalValue] = useState(value);
  const lastYRef = useRef(0);
  const valueRef = useRef(value);
  const rawRef = useRef(value); // unstepped accumulator for smooth dragging

  // Sync external value changes
  useEffect(() => {
    setInternalValue(value);
    valueRef.current = value;
    rawRef.current = value;
  }, [value]);

  const clampAndStep = useCallback(
    (v: number) => {
      let clamped = Math.max(min, Math.min(max, v));
      if (step > 0) {
        clamped = Math.round(clamped / step) * step;
      }
      return clamped;
    },
    [min, max, step],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      lastYRef.current = e.clientY;

      const onMouseMove = (e: MouseEvent) => {
        const dy = lastYRef.current - e.clientY;
        lastYRef.current = e.clientY;
        const range = max - min;
        const sensitivity = e.shiftKey ? FINE_SENSITIVITY : SENSITIVITY;
        // Accumulate raw (unstepped) value so fractional movement isn't lost
        rawRef.current = Math.max(min, Math.min(max, rawRef.current + dy * range * sensitivity));
        const newVal = clampAndStep(rawRef.current);
        if (newVal !== valueRef.current) {
          valueRef.current = newVal;
          setInternalValue(newVal);
          onChange(newVal);
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [min, max, clampAndStep, onChange],
  );

  const handleDoubleClick = useCallback(() => {
    const v = clampAndStep(defaultValueRef.current);
    rawRef.current = v;
    valueRef.current = v;
    setInternalValue(v);
    onChange(v);
  }, [clampAndStep, onChange]);

  const pct = (internalValue - min) / (max - min);
  const valueAngle = START_ANGLE + pct * ARC_SPAN;
  const displayValue = formatValue ? formatValue(internalValue) : `${internalValue}`;

  // Value arc path
  const valEnd = toXY(valueAngle, ARC_R);
  const largeArc = pct * ARC_SPAN > 180 ? 1 : 0;
  const valuePath =
    pct > 0.005
      ? `M${arcStart.x.toFixed(2)},${arcStart.y.toFixed(2)} A${ARC_R},${ARC_R} 0 ${largeArc} 1 ${valEnd.x.toFixed(2)},${valEnd.y.toFixed(2)}`
      : '';

  // Indicator dot position
  const dot = toXY(valueAngle, ARC_R);

  // Pointer line from body edge toward dot
  const pointerInner = toXY(valueAngle, BODY_R + 1);

  return (
    <div className="knob-container">
      <div className="knob-label">{label}</div>
      <svg
        className="knob-svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        {/* Track arc (background) */}
        <path d={trackPath} className="knob-track-arc" />

        {/* Value arc (filled portion) */}
        {valuePath && <path d={valuePath} className="knob-value-arc" />}

        {/* Knob body */}
        <circle cx={CX} cy={CY} r={BODY_R} className="knob-body" />

        {/* Body highlight (top specular) */}
        <circle cx={CX} cy={CY - 1} r={BODY_R - 2} className="knob-body-highlight" />

        {/* Pointer line */}
        <line
          x1={pointerInner.x}
          y1={pointerInner.y}
          x2={dot.x}
          y2={dot.y}
          className="knob-pointer"
        />

        {/* Indicator dot */}
        <circle cx={dot.x} cy={dot.y} r={DOT_R} className="knob-dot" />
      </svg>
      <div className="knob-value">{displayValue}</div>
    </div>
  );
}
