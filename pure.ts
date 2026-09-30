// Pure helpers (no Deno KV/network/side effects) shared by main.ts and tests.
// Importing this module never starts the server.

// Go-docs request-count cells can carry promo markup:
// ~~6,500~~<br />**26,000**, <small>4x · Ends Sep 20</small>, **bold**.
// Take the last number (the current value, not struck-through history).
// "Unlimited" is a real state, not a parse failure: the model is not metered,
// so return Infinity. NaN still means "could not read this cell".
export function cleanReqCount(cell: string | undefined): number {
  if (!cell) return NaN;
  const text = cell.replace(/<[^>]*>/g, " ").replace(/[*~]/g, " ");
  if (/unlimited/i.test(text)) return Infinity;
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

// ---------------------------------------------------------------------------
// Go docs MDX table parsing
// ---------------------------------------------------------------------------

export function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export type MdTable = { headers: string[]; rows: string[][] };

// Returns every table in document order. Tables are NOT deduplicated by header:
// the Go docs publish the same request-limits table once per plan with
// identical headers, and collapsing them would silently drop one plan.
export function parseMarkdownTables(text: string): MdTable[] {
  const tables: MdTable[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 3) {
        const headers = parseTableRow(tableLines[0]);
        const rows: string[][] = [];
        for (let j = 2; j < tableLines.length; j++) {
          rows.push(parseTableRow(tableLines[j]));
        }
        tables.push({ headers, rows });
      }
    } else {
      i++;
    }
  }
  return tables;
}

// Case-insensitive on purpose: these headers are prose in a file we do not
// control, and OpenCode has re-capitalized them ("requests per 5 hours" ->
// "Requests per 5 hours"), which silently emptied the whole limits column.
// Matching case-sensitively turned that cosmetic edit into a total parse
// failure, so compare casefolded.
function headerMatches(headers: string[], headerMatch: string): boolean {
  const needle = headerMatch.toLowerCase();
  return headers.some((h) => h.toLowerCase().includes(needle));
}

// All matching tables, in document order (see parseMarkdownTables).
export function findTables(tables: MdTable[], headerMatch: string): MdTable[] {
  return tables.filter((t) => headerMatches(t.headers, headerMatch));
}

export function findTable(
  tables: MdTable[],
  headerMatch: string,
): MdTable | null {
  return tables.find((t) => headerMatches(t.headers, headerMatch)) ?? null;
}

// Creator is resolved per model id. A first-word family hint exists (see
// creatorFamily) but is only ever populated from a real answer, so nothing is
// inferred from the shape of an id.
export type CreatorMap = Record<string, string>;
export type CreatorFamilies = Record<string, string>;

// Grouping key for the family hint only. "longcat-2.0" and
// "longcat-2.5-preview-free" share the family "longcat", so once the former's
// creator is known the latter can reuse it. This is NOT a source of truth and
// is never consulted to invent a creator: an earlier version used the first
// word as the cache key itself, which wrote space-bunny-free's 404 onto the
// family "space" and would have poisoned any future space-* model.
export function creatorFamily(id: string): string {
  return id.split(/[-.]/)[0] ?? "";
}

// Precedence for a single model's creator. AA's per-model slug wins (it is
// per-model and already in hand), then a memoized per-model answer, then a
// family hint learned from a real answer. Returns "" when nothing is known, so
// the caller renders the empty creator rather than a guess.
//
// Note the family hint is consulted before spending a request on the model
// itself. That trades per-model accuracy for fewer lookups: if a source ever
// mislabels a vendor, the error now propagates across the family instead of
// being caught by the model's own lookup.
export function knownCreator(
  id: string,
  aaSlug: string | undefined,
  creators: CreatorMap,
  families: CreatorFamilies,
): string {
  if (aaSlug) return aaSlug;
  const own = creators[id];
  if (own) return own;
  return families[creatorFamily(id)] ?? "";
}

// Reduce the vendor prefixes of CloudPrice 409 candidates to one creator.
// A 409 is usually one model listed under several variants ("minimax-m2-7",
// "minimax-m2-7-free", "minimax-m2-7-highspeed"), which collapses here for
// free. Returns null when empty or genuinely ambiguous, so the caller can
// retry against an exact candidate id instead of guessing. Same-vendor-different-slug
// sets ("z-ai-glm-5-3-flash" alongside "zhipu-glm-5-3-flash") also land in the
// null case and take that retry; that is accepted, since the column is
// informational and the retry resolves either way.
export function collapseCreator(slugs: string[]): string | null {
  const set = new Set(slugs.filter((s) => s));
  return set.size === 1 ? [...set][0] : null;
}

// Candidate model ids out of a CloudPrice 409 multiple_matches body. Null-safe:
// a non-409 error, or a body without details, yields no candidates.
export function creatorCandidates(body: unknown): string[] {
  const candidates = (body as {
    error?: { details?: { candidates?: { id?: string }[] } };
  })?.error?.details?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.map((c) => c?.id ?? "").filter((s) => s.length > 0);
}

// Models that still need a creator lookup of their own: not answerable from a
// family hint, not already resolved, and either never attempted or empty with
// this refresh cycle's retry still unspent. Anything else is terminal and must
// not be counted, otherwise the client poll loop never reaches zero.
export function pendingCreatorModels(
  goIds: string[],
  creators: CreatorMap,
  families: CreatorFamilies,
  retried: Record<string, number>,
): string[] {
  const out: string[] = [];
  for (const id of goIds) {
    if (families[creatorFamily(id)]) continue;
    const value = creators[id];
    if (value) continue;
    if (value === "" && retried[id]) continue;
    out.push(id);
  }
  return out;
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
