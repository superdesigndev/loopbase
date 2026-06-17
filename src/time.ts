// Relative time + duration parsing for list filters/output.

export function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*([smhdw])$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const mult: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return n * mult[unit]!;
}

export function relativeTime(epochMs: number | null, nowMs: number): string {
  if (epochMs == null) return "?";
  const diff = Math.max(0, nowMs - epochMs);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
