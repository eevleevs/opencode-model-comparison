// OpenCode Go Model Leaderboard
// Fetches the latest models available on OpenCode Go, their utilization limits
// (from the Go docs), and coding benchmarks (primary: Artificial Analysis v2
// bulk; fallback: CloudPrice per-model), then ranks them by a "value" score
// = benchmark performance × requests per month.
//
// Deno Deploy is serverless: isolates idle-shutdown and requests that run too
// long are killed (502). So NO request ever does more than one CloudPrice call
// or one AA bulk call. AA-covered models resolve via the daily bulk cache;
// the client polls GET /?tick=1 (one CloudPrice fetch per tick) only for
// AA-misses until those resolve. The page always renders whatever is in KV
// immediately (stale-while-revalidate).
//
// Deploy: `deno run --allow-net --allow-read --allow-env --unstable-kv main.ts`
// Local: copy .env.example to .env for AA_API_KEY (see README).

const OC_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const GO_DOCS_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx";
const CLOUDPRICE = "https://ai.cloudprice.net/api/v1";

const BENCHMARKS = [
  { slug: "scicode", label: "SciCode", coding: true },
  { slug: "coding_index", label: "CodInd", coding: true },
  { slug: "lcr", label: "LCR", coding: true },
  { slug: "terminalbench_hard", label: "TermBench", coding: true },
  { slug: "tau2", label: "TAU2", coding: true },
  { slug: "ifbench", label: "IFBench", coding: true },
  { slug: "intelligence_index", label: "IntInd", coding: false },
  { slug: "gpqa", label: "GPQA", coding: false },
  { slug: "hle", label: "HLE", coding: false },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hard wall-clock budget for one tick request so it can never approach the
// Deno Deploy request limit. CloudPrice replies in tens of ms normally; 15s
// covers even pathological 429 retry-after values without sleeping forever.
const TICK_BUDGET_MS = 15000;

// Data never expires, but auto-refresh if older than this (1 week).
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Re-check the Go model list at most this often.
const GO_LIST_CHECK_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(
  url: string,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "opencode-go-leaderboard/1.0",
        ...extraHeaders,
      },
      signal: ac.signal,
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const secs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : 10;
      throw new RateLimitedError(secs * 1000);
    }
    if (!res.ok) {
      // Keep the parsed body: CloudPrice answers 409 multiple_matches with the
      // candidate model ids, which is the only way to resolve an ambiguous id.
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON error body; the status is all we get.
      }
      throw new HttpError(
        res.status,
        `GET ${url} -> ${res.status}`,
        body,
      );
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

class RateLimitedError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("rate limited");
    this.retryAfterMs = retryAfterMs;
  }
}

class HttpError extends Error {
  status: number;
  // Parsed error payload when the response had one (see fetchJson).
  body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Go utilization limits (from docs MDX)
// ---------------------------------------------------------------------------

type GoLimit = {
  // Null on every count when unlimited is true. Never Infinity: this value is
  // serialized to the client, and JSON.stringify turns Infinity into null.
  reqPer5h: number | null;
  reqPerWeek: number | null;
  reqPerMonth: number | null;
  // The docs publish "Unlimited" for non-metered models, which is a distinct
  // state from "no data": these are ranked first and flagged with an ∞ glyph.
  unlimited?: boolean;
};

type GoLimits = {
  limits: Record<string, GoLimit>;
  fetchedAt: number;
};

// The docs change whenever OpenCode adjusts a plan or a promo multiplier
// ("4x · Ends Sep 20"), so a weekly snapshot can outlive the numbers in it.
// One unauthenticated raw.githubusercontent fetch a day is cheap.
const GO_LIMITS_TTL_MS = 24 * 60 * 60 * 1000;

import {
  aaRankPercentile,
  cleanName,
  cleanReqCount,
  collapseCreator,
  creatorCandidates,
  creatorFamily,
  findTable,
  findTables,
  knownCreator,
  parseMarkdownTables,
  pendingCreatorModels,
  rankPercentile,
} from "./pure.ts";

// The docs publish the request-limits table once per plan ("Go" and "Go Plus")
// with identical headers. They used to differ enough to be distinguishable, so
// the first match won and the leaderboard showed Go-plan limits; now they are
// byte-identical, so the choice has to be explicit or it flips silently and
// inflates every Value by ~3x. Index 0 is "Go" ($10/mo), index 1 is
// "Go Plus" ($40/mo).
const GO_LIMITS_PLAN_INDEX = 0;

// Fetch and parse the Go docs. Returns null instead of throwing so a broken
// or mid-edit upstream file cannot empty the limits column: stale numbers are
// recoverable, a blank column is not.
async function refetchGoLimits(): Promise<GoLimits["limits"] | null> {
  try {
    console.log("[build] fetching Go docs MDX...");
    const res = await fetch(GO_DOCS_URL, {
      headers: { "user-agent": "opencode-go-leaderboard/1.0" },
    });
    if (!res.ok) throw new Error(`GET ${GO_DOCS_URL} -> ${res.status}`);
    const mdx = await res.text();
    const tables = parseMarkdownTables(mdx);
    const endpointsTable = findTable(tables, "Model ID");
    const requestsTables = findTables(tables, "requests per 5 hour");
    const requestsTable = requestsTables[GO_LIMITS_PLAN_INDEX];
    if (!endpointsTable || !requestsTable) {
      throw new Error(
        `Failed to parse Go docs tables (found ${requestsTables.length} request tables)`,
      );
    }
    const displayNameToId = new Map<string, string>();
    for (const row of endpointsTable.rows) {
      const displayName = cleanName(row[0]);
      const modelId = row[1]?.trim();
      if (displayName && modelId) displayNameToId.set(displayName, modelId);
    }
    const limits: GoLimits["limits"] = {};
    const skipped: string[] = [];
    const unlimited: string[] = [];
    for (const row of requestsTable.rows) {
      const displayName = cleanName(row[0]);
      const reqPer5h = cleanReqCount(row[1]);
      const reqPerWeek = cleanReqCount(row[2]);
      const reqPerMonth = cleanReqCount(row[3]);
      const id = displayNameToId.get(displayName);
      if (!id) {
        skipped.push(`${displayName} (no endpoint id)`);
        continue;
      }
      if (reqPer5h === Infinity && reqPerWeek === Infinity && reqPerMonth === Infinity) {
        // "Unlimited" in all three columns: not metered at all. Counts are null
        // so the client flags it rather than ranking a fake number.
        limits[id] = {
          reqPer5h: null,
          reqPerWeek: null,
          reqPerMonth: null,
          unlimited: true,
        };
        unlimited.push(displayName);
        continue;
      }
      if (isNaN(reqPer5h) || isNaN(reqPerWeek) || isNaN(reqPerMonth)) {
        // Covers both unreadable cells and a mix of metered and Unlimited,
        // which is a docs inconsistency rather than a state we can rank.
        skipped.push(`${displayName} (unparsed counts)`);
        continue;
      }
      limits[id] = { reqPer5h, reqPerWeek, reqPerMonth };
    }
    if (skipped.length) {
      console.log(`[build] limits skipped rows: ${skipped.join("; ")}`);
    }
    if (unlimited.length) {
      console.log(`[build] unlimited models: ${unlimited.join(", ")}`);
    }
    console.log(
      `[build] parsed ${Object.keys(limits).length} model limits from Go docs`,
    );
    return limits;
  } catch (e) {
    console.log(`[build] Go docs fetch/parse failed: ${(e as Error).message}`);
    return null;
  }
}

async function fetchGoLimits(
  forceRefresh = false,
): Promise<GoLimits["limits"]> {
  const previous = await kv.get<GoLimits>(KV_GO_LIMITS);
  const cached = previous.value;
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < GO_LIMITS_TTL_MS) {
    return cached.limits;
  }
  const refreshed = await refetchGoLimits();
  if (!refreshed) {
    // Keep serving the last good snapshot rather than blanking every row.
    if (cached) {
      console.log("[build] keeping cached limits snapshot");
      return cached.limits;
    }
    throw new Error("Go docs limits unavailable and nothing cached");
  }
  await kv.set(KV_GO_LIMITS, { limits: refreshed, fetchedAt: Date.now() });
  return refreshed;
}

// ---------------------------------------------------------------------------
// KV store
// ---------------------------------------------------------------------------

const kv = await Deno.openKv();
const KV_GO_IDS = ["go", "ids"];
const KV_GO_CHECKED = ["go", "checkedAt"];
const KV_GO_REFRESH = ["go", "refreshAt"];
// Parsed from the Go docs MDX. Invalidated when the Go model list gains a
// model, so a new model gets limits on the next request instead of waiting
// out the TTL.
const KV_GO_LIMITS = ["go-limits"];

function kvModelKey(id: string): string[] {
  return ["model", id];
}

// ---------------------------------------------------------------------------
// Per-model benchmark fetch
// ---------------------------------------------------------------------------

type CpiScore = {
  metric: string;
  value?: number;
  percentile?: number;
  rank?: number;
  total?: number;
};
type CpiSource = { scores?: CpiScore[] };
type CpiPayload = { data?: { sources?: CpiSource[] } };

type ModelData = {
  value: Record<string, number>;
  percentile: Record<string, number>;
  // Rank/total per metric for uniform rank-percentile recomputation.
  // Older KV entries lack these and fall back to stored percentile.
  rank?: Record<string, number>;
  total?: Record<string, number>;
};

type EmptyReason =
  | "404"
  | "409"
  | "empty-sources"
  | "no-wanted-metrics";

type CachedModel =
  | { data: ModelData; fetchedAt: number }
  | {
    empty: true;
    fetchedAt: number;
    reason?: EmptyReason;
    sourcesCount?: number;
  };

// Slugs we actually display. A response with only speed metrics
// (output_tps/ttft_seconds) must count as empty, not ok.
const WANTED_METRICS = new Set(BENCHMARKS.map((b) => b.slug));

// One CloudPrice call for a single model. No retry-sleeping: 429/timeout fold
// into a "not yet" result and the client retries a later tick.
async function fetchModelOnce(
  id: string,
): Promise<
  | { kind: "ok"; data: ModelData }
  | { kind: "empty"; reason: EmptyReason; sourcesCount: number }
  | { kind: "rateLimited"; retryAfterMs: number }
  | { kind: "error" }
> {
  try {
    const d = (await fetchJson(
      `${CLOUDPRICE}/models/${id}/benchmarks`,
      TICK_BUDGET_MS,
    )) as CpiPayload;
    const srcs = d?.data?.sources ?? [];
    if (!srcs.length) {
      console.log(`[tick] empty ${id} reason=empty-sources sources=0`);
      return { kind: "empty", reason: "empty-sources", sourcesCount: 0 };
    }
    const value: Record<string, number> = {};
    const percentile: Record<string, number> = {};
    const rank: Record<string, number> = {};
    const total: Record<string, number> = {};
    for (const src of srcs) {
      for (const s of src.scores ?? []) {
        if (typeof s.value === "number") value[s.metric] = s.value;
        if (typeof s.percentile === "number") {
          percentile[s.metric] = s.percentile;
        }
        if (typeof s.rank === "number") rank[s.metric] = s.rank;
        if (typeof s.total === "number") total[s.metric] = s.total;
      }
    }
    const wanted = Object.keys(value).filter((k) => WANTED_METRICS.has(k));
    if (wanted.length === 0) {
      console.log(
        `[tick] empty ${id} reason=no-wanted-metrics sources=${srcs.length} metrics=${Object.keys(value).join(",")}`,
      );
      return {
        kind: "empty",
        reason: "no-wanted-metrics",
        sourcesCount: srcs.length,
      };
    }
    return { kind: "ok", data: { value, percentile, rank, total } };
  } catch (e) {
    if (e instanceof RateLimitedError) {
      console.log(`[tick] 429 on ${id}, retry in ${e.retryAfterMs}ms`);
      return { kind: "rateLimited", retryAfterMs: e.retryAfterMs };
    }
    if (e instanceof HttpError && (e.status === 404 || e.status === 409)) {
      const reason: EmptyReason = e.status === 404 ? "404" : "409";
      console.log(`[tick] empty ${id} reason=${reason} sources=0`);
      return { kind: "empty", reason, sourcesCount: 0 };
    }
    console.log(`[tick] fetch failed for ${id}: ${(e as Error).message}`);
    return { kind: "error" };
  }
}

// ---------------------------------------------------------------------------
// Artificial Analysis v2 bulk (primary) with CloudPrice fallback
// Free tier: 100 req/day is plenty for 1 bulk/day cached in KV.
// Needs AA_API_KEY env (server-side only, never exposed to the browser).
// When missing, we silently fall back to CloudPrice-only.
// ---------------------------------------------------------------------------

const AA_BASE = "https://artificialanalysis.ai/api/v2";
const AA_BULK_TTL_MS = 24 * 60 * 60 * 1000;
// Deno KV values cap at 64KiB, so the full AA catalog (~1000 models with
// pricing/performance) can never fit in one key. We persist only the compact
// per-Go-model subset, one small key per model.
const KV_AA_BULK = ["aa", "bulk"];
const KV_AA_MODEL_PREFIX = ["aa", "model"];
const KV_AA_DIST_PREFIX = ["aa", "dist"];
const KV_AA_FETCHED = ["aa", "fetchedAt"];

const kvAaModelKey = (id: string): string[] => [
  ...KV_AA_MODEL_PREFIX,
  normId(id),
];

const kvAaDistKey = (slug: string): string[] => [...KV_AA_DIST_PREFIX, slug];

type AaBulkModel = {
  slug?: string;
  name?: string;
  // Vendor of the model, e.g. { id, name: "Anthropic", slug: "anthropic" }.
  // This is the creator source: present on every model in the v2 bulk payload.
  model_creator?: AaCreator;
  evaluations?: Record<string, number | null>;
};

type AaCreator = { id?: string; name?: string; slug?: string };

type AaBulkCache = { models: AaBulkModel[]; fetchedAt: number };

// AA evaluation keys -> our BENCHMARK slugs (first hit wins).
const AA_TO_BENCH: Record<string, string[]> = {
  scicode: ["scicode"],
  coding_index: ["artificial_analysis_coding_index", "coding_index"],
  lcr: ["aa_lcr", "lcr"],
  terminalbench_hard: [
    "terminalbench_hard",
    "terminalbench_v2_1",
    "terminalbench_v4_0",
  ],
  tau2: ["tau2_telecom", "tau_banking", "tau2", "tau2_banking"],
  ifbench: ["ifbench"],
  intelligence_index: [
    "artificial_analysis_intelligence_index",
    "intelligence_index",
  ],
  gpqa: ["gpqa_diamond", "gpqa"],
  hle: ["hle"],
};

const normId = (s: string) =>
  s.toLowerCase().replace(/[_.]/g, "-").replace(/--+/g, "-");

function buildAaIndex(models: AaBulkModel[]): Map<string, AaBulkModel> {
  const idx = new Map<string, AaBulkModel>();
  for (const m of models) {
    const keys = new Set<string>();
    if (m.slug) {
      keys.add(m.slug.toLowerCase());
      keys.add(normId(m.slug));
    }
    if (m.name) {
      keys.add(m.name.toLowerCase());
      keys.add(normId(m.name));
    }
    for (const k of keys) {
      if (!idx.has(k)) idx.set(k, m);
    }
  }
  return idx;
}

function lookupAa(
  idx: Map<string, AaBulkModel>,
  goId: string,
): AaBulkModel | null {
  return idx.get(goId.toLowerCase()) ?? idx.get(normId(goId)) ?? null;
}

function aaValuesFor(
  m: AaBulkModel,
): { value: Record<string, number>; hits: string[] } {
  const value: Record<string, number> = {};
  const hits: string[] = [];
  const evals = m.evaluations ?? {};
  for (const b of BENCHMARKS) {
    for (const key of AA_TO_BENCH[b.slug] ?? [b.slug]) {
      const v = evals[key];
      if (typeof v === "number") {
        value[b.slug] = v;
        hits.push(`${b.slug}<-${key}`);
        break;
      }
    }
  }
  return { value, hits };
}

// Keep only the fields we join on + wanted evaluation numbers.
function compactAaModel(m: AaBulkModel): AaBulkModel {
  const evals = m.evaluations ?? {};
  const wanted = new Set(Object.values(AA_TO_BENCH).flat());
  const compact: Record<string, number> = {};
  for (const k of wanted) {
    const v = evals[k];
    if (typeof v === "number") compact[k] = v;
  }
  return {
    slug: m.slug,
    name: m.name,
    model_creator: m.model_creator,
    evaluations: compact,
  };
}

async function loadAaShard(): Promise<AaBulkModel[] | null> {
  const fetched = await kv.get<number>(KV_AA_FETCHED);
  if (!fetched.value || Date.now() - fetched.value >= AA_BULK_TTL_MS) {
    return null;
  }
  const models: AaBulkModel[] = [];
  const it = kv.list<AaBulkModel>({ prefix: KV_AA_MODEL_PREFIX });
  for await (const entry of it) {
    if (entry.value) models.push(entry.value);
  }
  return models.length ? models : null;
}

// Full-catalog sorted value distributions per benchmark slug, for rank
// percentiles (CloudPrice percentiles lag; AA free tier has none).
async function loadAaDists(): Promise<Record<string, number[]> | null> {
  const fetched = await kv.get<number>(KV_AA_FETCHED);
  if (!fetched.value || Date.now() - fetched.value >= AA_BULK_TTL_MS) {
    return null;
  }
  const dists: Record<string, number[]> = {};
  for (const b of BENCHMARKS) {
    const entry = await kv.get<number[]>(kvAaDistKey(b.slug));
    if (entry.value?.length) dists[b.slug] = entry.value;
  }
  return Object.keys(dists).length ? dists : null;
}

async function fetchAaBulk(
  force = false,
  goIds: string[] = [],
): Promise<AaBulkModel[] | null> {
  const apiKey = Deno.env.get("AA_API_KEY") ?? "";
  if (!apiKey) return null;
  if (!force) {
    const cached = await loadAaShard();
    if (cached) return cached;
  }
  console.log("[build] fetching AA bulk...");
  const d = (await fetchJson(
    `${AA_BASE}/data/llms/models`,
    TICK_BUDGET_MS,
    { "x-api-key": apiKey },
  )) as { data?: AaBulkModel[] };
  const models = d?.data ?? [];
  if (!models.length) throw new Error("AA bulk returned 0 models");
  const fullIdx = buildAaIndex(models);
  // Persist per-benchmark catalog distributions for rank percentiles.
  for (const b of BENCHMARKS) {
    const keys = AA_TO_BENCH[b.slug] ?? [b.slug];
    const vals: number[] = [];
    for (const m of models) {
      const evals = m.evaluations ?? {};
      for (const key of keys) {
        const v = evals[key];
        if (typeof v === "number") {
          vals.push(v);
          break;
        }
      }
    }
    vals.sort((x, y) => x - y);
    if (vals.length) await kv.set(kvAaDistKey(b.slug), vals);
  }
  // Persist only Go-matched compact models (tiny keys, no 64KiB issue).
  // Drop the legacy single-key cache if present.
  await kv.delete(KV_AA_BULK);
  let stored = 0;
  const matched: AaBulkModel[] = [];
  const seen = new Set<string>();
  for (const id of goIds) {
    const hit = lookupAa(fullIdx, id);
    if (hit) {
      matched.push(hit);
      const key = kvAaModelKey(id).join("/");
      if (!seen.has(key)) {
        seen.add(key);
        await kv.set(kvAaModelKey(id), compactAaModel(hit));
        stored++;
      }
    }
  }
  await kv.set(KV_AA_FETCHED, Date.now());
  console.log(
    `[build] AA bulk: ${models.length} total, ${matched.length}/${goIds.length} Go matched, ${stored} shard keys + dists stored`,
  );
  return matched;
}

type AaData = {
  idx: Map<string, AaBulkModel>;
  dists: Record<string, number[]> | null;
};

// Models AA covers (any wanted value) — these skip CloudPrice ticks.
function aaCoveredIds(idx: Map<string, AaBulkModel>, goIds: string[]): Set<string> {
  const covered = new Set<string>();
  for (const id of goIds) {
    const hit = lookupAa(idx, id);
    if (hit && Object.keys(aaValuesFor(hit).value).length > 0) {
      covered.add(id);
    }
  }
  return covered;
}

async function getAaData(
  goIds: string[] = [],
): Promise<AaData | null> {
  const apiKey = Deno.env.get("AA_API_KEY") ?? "";
  if (!apiKey) return null;
  try {
    const cached = await loadAaShard();
    if (cached) {
      return { idx: buildAaIndex(cached), dists: await loadAaDists() };
    }
    const models = await fetchAaBulk(false, goIds);
    if (!models) return null;
    return { idx: buildAaIndex(models), dists: await loadAaDists() };
  } catch (e) {
    console.log(`[build] AA bulk failed, fallback to CloudPrice: ${(e as Error).message}`);
    const cached = await loadAaShard();
    if (cached) {
      return { idx: buildAaIndex(cached), dists: await loadAaDists() };
    }
    return null;
  }
}

async function getAaIndex(
  goIds: string[] = [],
): Promise<Map<string, AaBulkModel> | null> {
  const data = await getAaData(goIds);
  return data?.idx ?? null;
}

// ---------------------------------------------------------------------------
// Creator (vendor) resolution
// ---------------------------------------------------------------------------
// Resolved per model id. AA is primary and carries model_creator for most of
// the Go list, free from the bulk we already hold; CloudPrice's single-model
// endpoint fills only the models AA does not cover, one per tick.
//
// A creator is either resolved (slug), empty (""), or not attempted yet. An
// empty creator is rendered as the client's default placeholder rather than
// guessed, and earns one further lookup at the next manual refresh. Only
// un-attempted models and empty ones with that retry unspent count as pending,
// which is what guarantees the client poll loop terminates.

const KV_CREATORS = ["meta", "creators"];

type CreatorState = {
  // model id -> creator slug, or "" when no creator is available.
  creators: Record<string, string>;
  // first word -> slug, learned only from a model that actually resolved. Lets
  // a sibling model reuse a known creator instead of spending a request, and is
  // never written from a miss.
  families: Record<string, string>;
  // Exact CloudPrice id to retry, when a 409 handed us candidate ids. Its
  // presence also marks the one in-cycle retry as spent.
  pendingCandidate: Record<string, string>;
  // model id -> timestamp once this refresh cycle's retry has been spent on an
  // empty creator. Cleared by ?refresh=1, which grants one more attempt.
  retried: Record<string, number>;
};

async function loadCreatorState(): Promise<CreatorState> {
  const entry = await kv.get<CreatorState>(KV_CREATORS);
  const v = entry.value as Partial<CreatorState> | null;
  // Tolerate entries written by an earlier shape rather than blowing up on a
  // missing field: creators is the only one that must exist.
  return {
    creators: v?.creators ?? {},
    families: v?.families ?? {},
    pendingCandidate: v?.pendingCandidate ?? {},
    retried: v?.retried ?? {},
  };
}

async function saveCreatorState(state: CreatorState): Promise<void> {
  await kv.set(KV_CREATORS, state);
}

function markCreatorResolved(state: CreatorState, id: string, slug: string): void {
  state.creators[id] = slug;
  // First real answer for this family wins, so the family stays self-consistent
  // no matter which source taught it.
  const family = creatorFamily(id);
  if (family && !state.families[family]) state.families[family] = slug;
  delete state.pendingCandidate[id];
  delete state.retried[id];
}

// No creator available. Carry it as empty and spend this cycle's retry so the
// model stops counting as pending; ?refresh=1 clears that and tries once more.
// Deliberately does not touch families: a miss for one model says nothing
// about its siblings.
function markCreatorEmpty(state: CreatorState, id: string): void {
  state.creators[id] = "";
  state.retried[id] = Date.now();
  delete state.pendingCandidate[id];
}

// Seed from the AA bulk we already hold. Free, and it means the models AA
// covers never cost a CloudPrice call. Also upgrades an empty creator if AA
// has started covering a model it previously missed.
async function seedCreatorsFromAa(
  goIds: string[],
  idx: Map<string, AaBulkModel> | null,
): Promise<CreatorState> {
  const state = await loadCreatorState();
  if (!idx) return state;
  let changed = false;
  for (const id of goIds) {
    if (state.creators[id]) continue;
    const slug = lookupAa(idx, id)?.model_creator?.slug;
    if (!slug) continue;
    markCreatorResolved(state, id, slug);
    changed = true;
    console.log(`[creator] seeded ${id} -> ${slug} from AA`);
  }
  if (changed) await saveCreatorState(state);
  return state;
}

// Vendor prefix of each 409 candidate id: "xai-grok-4-7" -> "xai".
function creatorPrefixes(candidates: string[]): string[] {
  return candidates.map((id) => id.split("-")[0] ?? "");
}

type CreatorLookup =
  | { kind: "ok"; creator: string }
  | { kind: "empty" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "rateLimited"; retryAfterMs: number }
  | { kind: "error" };

// One CloudPrice model lookup. The catalog gains variants continuously, so an
// id can flip between 200 and 409 (multiple_matches) at any time; the 409 body
// carries the candidate ids to collapse.
async function lookupCreator(cpiId: string): Promise<CreatorLookup> {
  try {
    const d = (await fetchJson(
      `${CLOUDPRICE}/models/${encodeURIComponent(cpiId)}`,
      TICK_BUDGET_MS,
    )) as { data?: { creator?: string } };
    const creator = d?.data?.creator;
    return typeof creator === "string" && creator
      ? { kind: "ok", creator }
      : { kind: "empty" };
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return { kind: "rateLimited", retryAfterMs: e.retryAfterMs };
    }
    if (e instanceof HttpError && e.status === 404) return { kind: "empty" };
    if (e instanceof HttpError && e.status === 409) {
      return {
        kind: "ambiguous",
        candidates: creatorCandidates(e.body),
      };
    }
    return { kind: "error" };
  }
}

// Resolve at most one model's creator per request, keeping the tick's
// one-CloudPrice-call-per-request invariant.
async function tickCreator(
  goIds: string[],
  aaIdx: Map<string, AaBulkModel> | null,
): Promise<{
  touched: boolean;
  retryAfterMs: number | null;
}> {
  // Seed from AA first: a manual refresh drops the memo, and without this the
  // models AA already covers would each cost a CloudPrice call.
  const state = await seedCreatorsFromAa(goIds, aaIdx);
  const pending = pendingCreatorModels(
    goIds,
    state.creators,
    state.families,
    state.retried,
  );
  if (!pending.length) return { touched: false, retryAfterMs: null };

  const id = pending[0];
  const cpiId = state.pendingCandidate[id] ?? id;
  const r = await lookupCreator(cpiId);

  if (r.kind === "rateLimited") {
    // Nothing persisted: the model stays pending and the client waits out the
    // retry-after.
    return { touched: true, retryAfterMs: r.retryAfterMs };
  }

  let outcome: string;
  if (r.kind === "ok") {
    markCreatorResolved(state, id, r.creator);
    outcome = "ok";
  } else if (r.kind === "ambiguous") {
    // Prefer collapsing the candidates: a 409 is usually one vendor listed
    // under several variants or slugs ("z-ai" and "zhipu" for Z.AI).
    const collapsed = collapseCreator(creatorPrefixes(r.candidates));
    if (collapsed) {
      markCreatorResolved(state, id, collapsed);
      outcome = "ok";
    } else if (!state.pendingCandidate[id]) {
      // One in-cycle retry against an exact candidate id, which bypasses the
      // fuzzy match that produced the ambiguity in the first place. Bounded:
      // the second ambiguous answer falls through to empty below.
      state.pendingCandidate[id] = r.candidates[0];
      outcome = "ambiguous, retrying exact id";
    } else {
      markCreatorEmpty(state, id);
      outcome = "ambiguous";
    }
  } else {
    // 404, or a transient error. Either way we have no creator to show, so
    // carry it empty and retry once at the next refresh.
    markCreatorEmpty(state, id);
    outcome = r.kind;
  }

  await saveCreatorState(state);
  console.log(
    `[creator] ${id} -> ${state.creators[id] || "(empty)"} via ${cpiId} (${outcome})`,
  );
  return { touched: true, retryAfterMs: null };
}

// ---------------------------------------------------------------------------
// Go model list (change detection)
// ---------------------------------------------------------------------------

async function getGoModelIds(): Promise<string[]> {
  const res = await fetchJson(OC_GO_MODELS_URL, TICK_BUDGET_MS) as {
    data: { id: string }[];
  };
  return res.data.map((m) => m.id);
}

async function ensureGoIds(): Promise<string[]> {
  const checked = await kv.get<number>(KV_GO_CHECKED);
  if (checked.value && Date.now() - checked.value < GO_LIST_CHECK_MS) {
    const cached = await kv.get<string[]>(KV_GO_IDS);
    if (cached.value) return cached.value;
  }

  const live = await getGoModelIds();
  const cached = await kv.get<string[]>(KV_GO_IDS);

  if (!cached.value || !setsEqual(live, cached.value)) {
    const oldSet = new Set(cached.value ?? []);
    const liveSet = new Set(live);
    const added = live.filter((id) => !oldSet.has(id));
    const removed = (cached.value ?? []).filter((id) => !liveSet.has(id));
    console.log(
      `[build] Go model list changed: +${added.length} added, -${removed.length} removed`,
    );
    // Only delete cache entries for models that are no longer in the Go list.
    for (const id of removed) await kv.delete(kvModelKey(id));
    if (added.length) {
      // Reset checkedAt so ticks immediately start fetching the new models.
      await kv.delete(KV_GO_CHECKED);
      // The docs publish limits per model, so a new model has none in the
      // cached snapshot and would show no limits (and no Value) until the TTL
      // expired. Drop the snapshot instead; the next fetch is one MDX request.
      await kv.delete(KV_GO_LIMITS);
    }
    await kv.set(KV_GO_IDS, live);
  }
  await kv.set(KV_GO_CHECKED, Date.now());
  return live;
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const id of b) {
    if (!set.has(id)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Assemble leaderboard from KV
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  name: string;
  creator: string;
  reqPer5h: number | null;
  reqPerWeek: number | null;
  reqPerMonth: number | null;
  // Docs publish "Unlimited" for non-metered models: counts are null and this
  // flag is set, so the client flags them and ranks them above metered models
  // instead of rendering a misleading dash.
  unlimited: boolean;
  benchmarks: Record<string, number | null>;
  percentiles: Record<string, number | null>;
  matched: boolean;
};

type BuildState = {
  rows: Row[];
  benchmarks: typeof BENCHMARKS;
  updatedAt: string;
  remaining: number;
  retryAfterMs: number | null;
};

async function assembleBuild(goIds: string[]): Promise<BuildState> {
  // Load any Go limits we already have; never fetch them in the hot path.
  let goLimits: Record<string, GoLimit> = {};
  const limitsEntry = await kv.get<GoLimits>(KV_GO_LIMITS);
  if (limitsEntry.value) goLimits = limitsEntry.value.limits;

  const entries = new Map<string, CachedModel>();
  const it = kv.list<CachedModel>({ prefix: ["model"] });
  for await (const entry of it) {
    const id = String(entry.key[1]);
    if (entry.value) entries.set(id, entry.value);
  }

  // AA bulk is primary for values AND rank percentiles; CloudPrice KV is
  // fallback for AA-misses (values + percentiles) and percentiles where
  // catalog distributions are unavailable.
  const aaData = await getAaData(goIds);
  const aaIdx = aaData?.idx ?? null;
  const aaDists = aaData?.dists ?? null;

  // Memoized first-word -> creator. Also seeds every token AA covers, so most
  // tokens never need a CloudPrice call.
  const creatorState = await seedCreatorsFromAa(goIds, aaIdx);
  const creatorTokens = creatorState.creators;
  const creatorFamilies = creatorState.families;

  const rows: Row[] = [];
  let matchedCount = 0;
  let aaFilled = 0;
  let aaPctFilled = 0;
  let limitsCount = 0;
  const emptyReasons: Record<string, number> = {};
  const noLimits: string[] = [];

  for (const id of goIds) {
    const limits = goLimits[id] ?? null;
    if (limits) limitsCount++;
    else noLimits.push(id);
    const cached = entries.get(id);

    const benchmarks: Record<string, number | null> = {};
    const percentiles: Record<string, number | null> = {};
    let matchedAny = false;

    if (cached && "data" in cached) {
      const data = cached.data;
      for (const b of BENCHMARKS) {
        benchmarks[b.slug] = data.value[b.slug] ?? null;
        // Uniform rank logic: recompute from rank/total (same family as
        // aaRankPercentile). Old KV entries lack rank/total and fall back
        // to the stored upstream percentile.
        const r = data.rank?.[b.slug];
        const t = data.total?.[b.slug];
        const recomputed = r != null && t != null
          ? rankPercentile(r, t)
          : NaN;
        percentiles[b.slug] = !isNaN(recomputed)
          ? recomputed
          : data.percentile[b.slug] ?? null;
        if (benchmarks[b.slug] != null) matchedAny = true;
      }
    } else {
      for (const b of BENCHMARKS) {
        benchmarks[b.slug] = null;
        percentiles[b.slug] = null;
      }
      if (cached && "empty" in cached) {
        const r = cached.reason ?? "unknown";
        emptyReasons[r] = (emptyReasons[r] ?? 0) + 1;
      }
    }

    // AA wins where present (fresher than the CloudPrice snapshot):
    // overwrite values and derive rank percentiles from catalog dists.
    let aaCreator = "";
    if (aaIdx) {
      const hit = lookupAa(aaIdx, id);
      if (hit) {
        aaCreator = hit.model_creator?.slug ?? "";
        const { value } = aaValuesFor(hit);
        let filledThis = false;
        let pctThis = false;
        for (const b of BENCHMARKS) {
          if (typeof value[b.slug] === "number") {
            if (benchmarks[b.slug] == null) filledThis = true;
            benchmarks[b.slug] = value[b.slug];
            matchedAny = true;
            const dist = aaDists?.[b.slug];
            if (dist?.length) {
              percentiles[b.slug] = aaRankPercentile(dist, value[b.slug]);
              pctThis = true;
            }
          }
        }
        if (filledThis) aaFilled++;
        if (pctThis) aaPctFilled++;
      }
    }

    // Creator: AA's per-model slug, else a memoized per-model answer, else a
    // family hint learned from a real answer, else "" so the client shows its
    // default placeholder rather than a guessed vendor.
    const creator = knownCreator(
      id,
      aaCreator || undefined,
      creatorTokens,
      creatorFamilies,
    );

    if (matchedAny) matchedCount++;

    rows.push({
      id,
      name: id,
      creator,
      reqPer5h: limits?.reqPer5h ?? null,
      reqPerWeek: limits?.reqPerWeek ?? null,
      reqPerMonth: limits?.reqPerMonth ?? null,
      unlimited: limits?.unlimited ?? false,
      benchmarks,
      percentiles,
      matched: matchedAny,
    });
  }

  const remaining = await countPending(goIds, creatorState);

  console.log(
    `[tick] assemble: ${matchedCount}/${goIds.length} matched, ${remaining} pending, aaFilled=${aaFilled}, aaPct=${aaPctFilled}, emptyReasons=${JSON.stringify(emptyReasons)}, aa=${aaIdx ? "on" : "off"}, limits=${limitsCount}/${goIds.length} noLimits=[${noLimits.join(",")}]`,
  );

  return {
    rows,
    benchmarks: BENCHMARKS,
    updatedAt: new Date().toISOString(),
    remaining,
    retryAfterMs: null,
  };
}

// ---------------------------------------------------------------------------
// Tick: fetch exactly one missing model, persist it, report progress
// ---------------------------------------------------------------------------
// CloudPrice ticks cover only AA-misses: AA is primary (values + rank
// percentiles), so re-ticking AA-covered models would overwrite fresher
// data with the lagging snapshot. Without an AA key, all models tick.

async function tick(
  goIds: string[],
  deadlineMs: number,
): Promise<{
  fetched: boolean;
  id: string | null;
  value?: Record<string, number>;
  percentile?: Record<string, number>;
  remaining: number;
  retryAfterMs: number | null;
}> {
  const refreshAt = (await kv.get<number>(KV_GO_REFRESH)).value ?? 0;
  const aaIdx = await getAaIndex(goIds);
  const covered = aaIdx ? aaCoveredIds(aaIdx, goIds) : new Set<string>();

  // Unresolved creator tokens take the tick slot when there is one. Taking it
  // here rather than appending a call keeps the one-CloudPrice-call-per-request
  // invariant, and creators land before the slower benchmark crawl.
  const creator = await tickCreator(goIds, aaIdx);
  if (creator.touched) {
    return {
      fetched: false,
      id: null,
      remaining: await countPending(goIds),
      retryAfterMs: creator.retryAfterMs,
    };
  }

  for (const id of goIds) {
    if (Date.now() > deadlineMs) break;

    // AA-covered models never need CloudPrice (values + percentiles from AA).
    if (covered.has(id)) continue;

    const cached = await kv.get<CachedModel>(kvModelKey(id));
    // Skip fresh entries, unless a manual refresh asked for revalidation.
    // Old data stays visible until the refetch succeeds (stale-while-revalidate).
    if (cached.value) {
      const age = Date.now() - cached.value.fetchedAt;
      if (cached.value.fetchedAt >= refreshAt && age < STALE_TTL_MS) continue;
    }

    const r = await fetchModelOnce(id);
    if (r.kind === "ok") {
      await kv.set(kvModelKey(id), {
        data: r.data,
        fetchedAt: Date.now(),
      });
      console.log(`[tick] fetched ${id}`);
      // Recompute percentiles with the uniform rank logic so live-patched
      // rows match what assembleBuild() renders.
      const pct: Record<string, number> = {};
      for (const k of Object.keys(r.data.value)) {
        const rk = r.data.rank?.[k];
        const tot = r.data.total?.[k];
        const recomputed = rk != null && tot != null
          ? rankPercentile(rk, tot)
          : NaN;
        const v = !isNaN(recomputed)
          ? recomputed
          : r.data.percentile[k];
        if (typeof v === "number") pct[k] = v;
      }
      return {
        fetched: true,
        id,
        value: r.data.value,
        percentile: pct,
        remaining: await countPending(goIds),
        retryAfterMs: null,
      };
    }
    if (r.kind === "empty") {
      await kv.set(kvModelKey(id), {
        empty: true,
        fetchedAt: Date.now(),
        reason: r.reason,
        sourcesCount: r.sourcesCount,
      });
      console.log(`[tick] recorded empty for ${id} reason=${r.reason}`);
      return { fetched: true, id, remaining: await countPending(goIds), retryAfterMs: null };
    }
    if (r.kind === "rateLimited") {
      return { fetched: false, id: null, remaining: await countPending(goIds), retryAfterMs: r.retryAfterMs };
    }
    // "error": transient failure — burn the rest of the tick budget waiting
    // so the client doesn't hammer the API again immediately.
    const waitMs = Math.max(0, deadlineMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    return { fetched: false, id: null, remaining: await countPending(goIds), retryAfterMs: null };
  }
  return { fetched: false, id: null, remaining: await countPending(goIds), retryAfterMs: null };
}

async function countPending(
  goIds: string[],
  seeded?: CreatorState,
): Promise<number> {
  const refreshAt = (await kv.get<number>(KV_GO_REFRESH)).value ?? 0;
  const aaIdx = await getAaIndex(goIds);
  const covered = aaIdx ? aaCoveredIds(aaIdx, goIds) : new Set<string>();
  // Unresolved creator tokens count as pending so the client's poll loop keeps
  // going; terminal negatives do not, which is what makes the loop terminate.
  // Callers that already seeded pass the state in rather than re-reading KV.
  const creatorState = seeded ?? await seedCreatorsFromAa(goIds, aaIdx);
  let remaining = pendingCreatorModels(
    goIds,
    creatorState.creators,
    creatorState.families,
    creatorState.retried,
  ).length;
  for (const id of goIds) {
    // AA-covered models resolve via bulk, never via ticks.
    if (covered.has(id)) continue;
    const cached = await kv.get<CachedModel>(kvModelKey(id));
    if (!cached.value) {
      remaining++;
      continue;
    }
    if (cached.value.fetchedAt < refreshAt) {
      remaining++;
      continue;
    }
    const age = Date.now() - cached.value.fetchedAt;
    if (age >= STALE_TTL_MS) {
      remaining++;
      continue;
    }
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// Rendered HTML
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (
      c,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]!),
  );
}

// Read fresh every request so template edits apply under watch mode without a
// restart (index.html isn't an import, so --watch doesn't track it).
const readHtml = () => Deno.readTextFile(new URL("./index.html", import.meta.url));

async function renderHtml(data: BuildState): Promise<string> {
  const { rows, benchmarks } = data;
  const rowJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  const benchJson = JSON.stringify(benchmarks).replace(/</g, "\\u003c");
  const buildJson = JSON.stringify(
    { remaining: data.remaining, retryAfterMs: data.retryAfterMs },
  ).replace(/</g, "\\u003c");
  return (await readHtml())
    .replace("__updatedAt__", escapeHtml(data.updatedAt))
    .replace("__rowJson__", rowJson)
    .replace("__benchJson__", benchJson)
    .replace("__buildJson__", buildJson);
}

async function serveHtml(data: BuildState): Promise<Response> {
  return new Response(await renderHtml(data), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Static files.
  if (url.pathname === "/index.js") {
    const js = await Deno.readTextFile(new URL("./index.js", import.meta.url));
    return new Response(js, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  if (url.pathname === "/index.css") {
    const css = await Deno.readTextFile(new URL("./index.css", import.meta.url));
    return new Response(css, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  if (url.pathname !== "/") {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const t0 = performance.now();
    // Re-fetch the Go list only when due; fetch limits if never cached.
    let goIds = await ensureGoIds();
    const t1 = performance.now();
    console.log(`[perf] ensureGoIds ${(t1 - t0).toFixed(1)}ms`);
    const isRefresh = url.searchParams.get("refresh") === "1";
    // Always ask: fetchGoLimits returns the cached snapshot when it is still
    // inside the TTL, so the only cost is one KV read. Gating this on key
    // absence (as it used to be) meant the TTL check was unreachable and the
    // snapshot never expired.
    if (!isRefresh) {
      try {
        await fetchGoLimits();
      } catch (e) {
        console.log(`[build] limits fetch failed: ${(e as Error).message}`);
      }
    }
    const t2 = performance.now();
    console.log(`[perf] limits check ${(t2 - t1).toFixed(1)}ms`);

    // Tick request: fetch at most one missing model, bounded in time.
    if (url.searchParams.get("tick") === "1") {
      const result = await tick(goIds, Date.now() + TICK_BUDGET_MS);
      return json(result);
    }

    // Debug: per-model cache status + AA coverage + limits (no fetch).
    if (url.searchParams.get("debug") === "1") {
      const aaIdx = await getAaIndex(goIds);
      const limitsEntry = await kv.get<GoLimits>(KV_GO_LIMITS);
      const goLimits = limitsEntry.value?.limits ?? {};
      const out: Record<string, unknown>[] = [];
      for (const id of goIds) {
        const cached = await kv.get<CachedModel>(kvModelKey(id));
        const aaHit = aaIdx ? lookupAa(aaIdx, id) : null;
        const aaVals = aaHit ? aaValuesFor(aaHit).value : {};
        out.push({
          id,
          cache: !cached.value
            ? "missing"
            : "data" in cached.value
            ? "data"
            : `empty:${cached.value.reason ?? "unknown"}`,
          sourcesCount: cached.value && "empty" in cached.value
            ? cached.value.sourcesCount ?? null
            : null,
          fetchedAt: cached.value?.fetchedAt ?? null,
          limits: goLimits[id] ?? null,
          aa: aaHit
            ? {
              slug: aaHit.slug ?? null,
              creator: aaHit.model_creator?.slug ?? null,
              values: aaVals,
            }
            : null,
        });
      }
      return json({ count: out.length, aa: aaIdx ? "on" : "off", models: out });
    }

    // Progressive refresh: mark all cached models for revalidation without
    // deleting them, so the page keeps showing old data while ticks refetch
    // one model per request (stale-while-revalidate).
    if (isRefresh) {
      console.log("[build] manual refresh requested");
      const live = await getGoModelIds();
      const cached = await kv.get<string[]>(KV_GO_IDS);
      const liveSet = new Set(live);
      const removed = (cached.value ?? []).filter((id) => !liveSet.has(id));
      for (const id of removed) await kv.delete(kvModelKey(id));
      await kv.set(KV_GO_IDS, live);
      await kv.set(KV_GO_REFRESH, Date.now());
      await kv.set(KV_GO_CHECKED, Date.now());
      // Drop memoized creators so ticks re-resolve them; AA re-seeds the
      // tokens it covers for free.
      await kv.delete(KV_CREATORS);
      try {
        await fetchGoLimits(true);
      } catch (e) {
        console.log(`[build] limits refresh failed: ${(e as Error).message}`);
      }
      try {
        await fetchAaBulk(true, live);
      } catch (e) {
        console.log(`[build] AA refresh failed: ${(e as Error).message}`);
      }
      goIds = live;
    }

    const state = await assembleBuild(goIds);
    console.log(`[perf] assembleBuild ${(performance.now() - t2).toFixed(1)}ms`);
    return await serveHtml(state);
  } catch (e) {
    const msg = (e as Error).message;
    return new Response(
      `<pre>Error building leaderboard:\n${escapeHtml(msg)}</pre>`,
      {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
}

const PORT = Number(Deno.env.get("PORT") ?? "8001") || 8001;
console.log(`[boot] AA ${(Deno.env.get("AA_API_KEY") ?? "") ? "on" : "off"}, PORT=${PORT}`);
Deno.serve({ port: PORT }, handler);
export default handler;