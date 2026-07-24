import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes, letting later conflicting utilities win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Short, URL-safe, sortable-ish id. */
export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/** Money for humans. Sub-cent amounts keep enough precision to be meaningful. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(5).replace(/0+$/, '')}`;
  return USD.format(value);
}

/** 12345 → "12.3K". Keeps token counts readable in tight columns. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 1_000) return String(Math.round(value));
  if (abs < 1_000_000) return `${(value / 1_000).toFixed(abs < 10_000 ? 1 : 0)}K`;
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** "3m ago" / "in 45s". Compact enough for table cells. */
export function relativeTime(ts: number | null): string {
  if (ts === null) return 'never';
  const delta = ts - Date.now();
  const abs = Math.abs(delta);
  const suffix = (s: string) => (delta < 0 ? `${s} ago` : `in ${s}`);

  if (abs < 5_000) return delta < 0 ? 'just now' : 'now';
  if (abs < 60_000) return suffix(`${Math.round(abs / 1_000)}s`);
  if (abs < 3_600_000) return suffix(`${Math.round(abs / 60_000)}m`);
  if (abs < 86_400_000) return suffix(`${Math.round(abs / 3_600_000)}h`);
  return suffix(`${Math.round(abs / 86_400_000)}d`);
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
