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

export function Knob({ label, min, max, value, step = 0, formatValue, onChange }: KnobProps) {
  const defaultValueRef = useRef(value);
  const [internalValue, setInternalValue] = useState(value);
  const lastYRef = useRef(0);
  const valueRef = useRef(value);

  // Sync external value changes
  useEffect(() => {
    setInternalValue(value);
    valueRef.current = value;
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
        const newVal = clampAndStep(valueRef.current + dy * range * sensitivity);
        valueRef.current = newVal;
        setInternalValue(newVal);
        onChange(newVal);
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
    valueRef.current = v;
    setInternalValue(v);
    onChange(v);
  }, [clampAndStep, onChange]);

  const pct = (internalValue - min) / (max - min);
  const deg = -135 + pct * 270;
  const displayValue = formatValue ? formatValue(internalValue) : `${internalValue}`;

  return (
    <div className="knob-container">
      <div className="knob-label">{label}</div>
      <div
        className="knob"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        <div className="knob-track" />
        <div
          className="knob-indicator"
          style={{ transform: `rotate(${deg}deg)` }}
        />
      </div>
      <div className="knob-value">{displayValue}</div>
    </div>
  );
}
