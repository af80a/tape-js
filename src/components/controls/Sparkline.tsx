import { useRef, useEffect } from 'react';

interface SparklineProps {
  /** Ring buffer data (full array, read circularly from cursor). */
  data: number[];
  /** Current write cursor in the ring buffer. */
  cursor: number;
  /** Value range. */
  min: number;
  max: number;
  /** Canvas dimensions. */
  width?: number;
  height?: number;
  /** Line color or a function mapping value to color. */
  color?: string | ((value: number) => string);
  /** Draw a zero-line at this value. */
  zeroLine?: number;
}

export function Sparkline({
  data,
  cursor,
  min,
  max,
  width = 200,
  height = 36,
  color = '#44cc44',
  zeroLine,
}: SparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const range = max - min;
    if (range <= 0) return;

    const len = data.length;
    const stepX = width / (len - 1);

    // Zero line
    if (zeroLine !== undefined) {
      const zy = height - ((zeroLine - min) / range) * height;
      ctx.strokeStyle = '#333a47';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, zy);
      ctx.lineTo(width, zy);
      ctx.stroke();
    }

    // Data line — read from oldest to newest
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const useColorFn = typeof color === 'function';
    const staticColor = typeof color === 'string' ? color : '#44cc44';

    for (let i = 0; i < len; i++) {
      // Read circularly: oldest sample is cursor+1, newest is cursor
      const idx = (cursor + 1 + i) % len;
      const v = data[idx];
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    if (useColorFn) {
      const newestVal = data[cursor];
      ctx.strokeStyle = (color as (v: number) => string)(newestVal);
    } else {
      ctx.strokeStyle = staticColor;
    }
    ctx.stroke();
  }, [data, cursor, min, max, width, height, color, zeroLine]);

  return (
    <canvas
      ref={canvasRef}
      className="sparkline"
      style={{ width, height }}
    />
  );
}
