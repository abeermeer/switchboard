import { cn } from '@/lib/utils';

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  tone?: 'accent' | 'ok' | 'warn' | 'down' | 'info' | 'muted';
  /** Fills the area under the line. */
  filled?: boolean;
  className?: string;
}

const TONES = {
  accent: 'text-accent',
  ok: 'text-ok',
  warn: 'text-warn',
  down: 'text-down',
  info: 'text-info',
  muted: 'text-faint',
};

/**
 * A tiny inline chart. Hand-rolled rather than pulled from recharts because it
 * renders inside table cells and stat tiles by the dozen, where a full charting
 * runtime per instance would dominate the render cost.
 */
export function Sparkline({
  data,
  width = 72,
  height = 20,
  tone = 'accent',
  filled = true,
  className,
}: SparklineProps): React.ReactElement {
  if (data.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={cn(TONES.muted, className)}
        aria-hidden="true"
      >
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="2 3"
          opacity="0.5"
        />
      </svg>
    );
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  // A flat series would divide by zero; drawing it mid-height is honest.
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pad = 1.5;
  const usable = height - pad * 2;

  const points = data.map((value, index) => {
    const x = index * step;
    const y = pad + usable - ((value - min) / range) * usable;
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn(TONES[tone], className)}
      aria-hidden="true"
    >
      {filled && <path d={area} fill="currentColor" opacity="0.12" />}
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
