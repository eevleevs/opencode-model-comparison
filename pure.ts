// Pure helpers (no Deno KV/network/side effects) shared by main.ts and tests.
// Importing this module never starts the server.

// Go-docs request-count cells can carry promo markup:
// ~~6,500~~<br />**26,000**, <small>4x · Ends Sep 20</small>, **bold**.
// Take the last number (the current value, not struck-through history).
export function cleanReqCount(cell: string | undefined): number {
  if (!cell) return NaN;
  const text = cell.replace(/<[^>]*>/g, " ").replace(/[*~]/g, " ");
  const matches = text.match(/[\d,]+/g);
  if (!matches) return NaN;
  return parseInt(matches[matches.length - 1].replace(/,/g, ""), 10);
}

// Display names can carry promo HTML too:
// "DeepSeek V4.1 Flash<br /><small>4x · Ends Sep 20</small>".
// Normalize both tables before joining.
export function cleanName(cell: string | undefined): string {
  if (!cell) return "";
  return cell
    .replace(/<small>.*?<\/small>/gis, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[*~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Uniform rank logic for both benchmark sources (same family, same rounding):
// rank 1 -> 100, last -> 0. Matches aaRankPercentile semantics.
export function rankPercentile(rank: number, total: number): number {
  if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 1) {
    return NaN;
  }
  const pct = Math.round(((total - rank) / (total - 1)) * 1000) / 10;
  return Math.min(100, Math.max(0, pct));
}

// Rank percentile of value within a sorted-ascending catalog distribution.
// Min -> 0, max -> 100, rounded to 1 decimal (CloudPrice scale).
export function aaRankPercentile(dist: number[], value: number): number {
  const n = dist.length;
  if (n <= 1) return 50;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  const pct = Math.round((lo / (n - 1)) * 1000) / 10;
  return Math.min(100, Math.max(0, pct));
}
