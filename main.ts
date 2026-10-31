// OpenCode Go Model Leaderboard
// Fetches the latest models available on OpenCode Go, their utilization limits
// (from the Go docs), and coding benchmarks (primary: Artificial Analysis v2
// bulk; fallback: CloudPrice per-model), then ranks them by a "value" score
// = benchmark performance × requests per month.
//
// Runs on Cloudflare Workers (migrated from Deno Deploy, which shuts down in
// ~April 2027). Persistence is Workers KV behind the KvLike adapter below,
// which mirrors the subset of the Deno KV API this app uses. NO request ever
// does more than one CloudPrice call or one AA bulk call: the client polls
// GET /?tick=1 (one CloudPrice fetch per tick) only for AA-misses until those
// resolve. The page always renders whatever is in KV immediately
// (stale-while-revalidate). KV only holds a rebuildable cache, so losing it
// just triggers a rebuild — there is no data to migrate.
//
// Deploy: `deno task deploy` (wrangler; see README).
// Local:  `deno task dev`, with AA_API_KEY in .dev.vars (.dev.vars.example).

const OC_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
// The docs live under services/www since the docs site moved to /v2/docs/...
// (the old packages/web/src/content/docs/go.mdx path 404s).
const GO_DOCS_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx";
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

// Hard wall-clock budget for one tick request. CloudPrice replies in tens of
// ms normally; 15s covers pathological upstream latency. Transient failures
// do NOT burn the budget sleeping (Workers dislikes long-lived requests):
// the tick returns retryAfterMs instead and the client backs off.
const TICK_BUDGET_MS = 15000;

// How long an in-isolate memo may serve AA/limits data without touching KV.
// Workers reuses isolates across requests, so this cuts KV reads (the
// tightest free-tier quota) to ~zero for steady traffic.
const MEMO_TTL_MS = 60_000;

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
  creatorSlug,
  findTable,
  findTables,
  knownCreator,
  parseMarkdownTables,
  pendingCreatorModels,
  rankPercentile,
} from "./pure.ts";

// Static assets are bundled as text modules (wrangler.jsonc `rules`), the
// Workers equivalent of the old Deno.readTextFile() calls.
import CLIENT_CSS from "./index.css";
import CLIENT_JS from "./index.js";
import HTML_PAGE from "./index.html";
import QUEUE_JS from "./queue.js";

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
    // A parse that yields 0 rows is a failure, not an empty dataset: returning
    // it would overwrite the last good snapshot with {} and blank Req/mo (and
    // with it Value) for every row. Throwing lands in the catch below, which
    // returns null so the caller keeps serving the cached snapshot.
    if (Object.keys(limits).length === 0) {
      throw new Error("Go docs parsed 0 model limits");
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

// In-isolate memo of the last good snapshot: the handler asks on every
// request, and Workers reuses isolates, so a memory read replaces a KV read
// (see MEMO_TTL_MS). ?refresh=1 passes forceRefresh and updates it.
let limitsMemo: { limits: GoLimits["limits"]; at: number } | null = null;

async function fetchGoLimits(
  forceRefresh = false,
): Promise<GoLimits["limits"]> {
  if (
    !forceRefresh && limitsMemo &&
    Date.now() - limitsMemo.at < MEMO_TTL_MS
  ) {
    return limitsMemo.limits;
  }
  const previous = await kv.get<GoLimits>(KV_GO_LIMITS);
  const cached = previous.value;
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < GO_LIMITS_TTL_MS) {
    limitsMemo = { limits: cached.limits, at: Date.now() };
    return cached.limits;
  }
  const refreshed = await refetchGoLimits();
  if (!refreshed) {
    // Keep serving the last good snapshot rather than blanking every row.
    if (cached) {
      console.log("[build] keeping cached limits snapshot");
      limitsMemo = { limits: cached.limits, at: Date.now() };
      return cached.limits;
    }
    throw new Error("Go docs limits unavailable and nothing cached");
  }
  await kv.set(KV_GO_LIMITS, { limits: refreshed, fetchedAt: Date.now() });
  limitsMemo = { limits: refreshed, at: Date.now() };
  return refreshed;
}

// ---------------------------------------------------------------------------
// Workers bindings + KV adapter
// ---------------------------------------------------------------------------
// This app only ever used the get/set/delete/list subset of Deno KV (no
// transactions), so it sits behind a KvLike interface that Workers KV
// implements below. Array keys map to slash-joined, URI-encoded strings, so
// no model id can collide with the separator.

type KvEntry<T> = { key: string[]; value: T | null };

interface KvLike {
  get<T>(key: string[]): Promise<{ value: T | null }>;
  set(key: string[], value: unknown): Promise<void>;
  delete(key: string[]): Promise<void>;
  // Deno KV auto-paginates; the adapter loops Workers KV cursors for us.
  list<T>(opts: { prefix: string[] }): AsyncIterable<KvEntry<T>>;
}

// Structural subset of a Workers KV binding, so the project typechecks
// without generated bindings (works for both wrangler dev and deploy).
interface WorkersKvBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

// Everything the handler needs from the Workers runtime. AA_API_KEY is set
// with `wrangler secret put AA_API_KEY`; locally it comes from .dev.vars.
interface WorkerEnv {
  KV: WorkersKvBinding;
  AA_API_KEY?: string;
}

const kvKey = (key: string[]): string => key.map(encodeURIComponent).join("/");

const kvUnkey = (key: string): string[] =>
  key.split("/").map(decodeURIComponent);

function workersKv(ns: WorkersKvBinding): KvLike {
  return {
    get: <T,>(key: string[]) =>
      ns.get(kvKey(key), "json").then((value) => ({
        value: (value ?? null) as T | null,
      })),
    set: (key, value) => ns.put(kvKey(key), JSON.stringify(value)),
    delete: (key) => ns.delete(kvKey(key)),
    list: <T,>(opts: { prefix: string[] }) => ({
      async *[Symbol.asyncIterator]() {
        let cursor: string | undefined;
        do {
          const page = await ns.list({ prefix: kvKey(opts.prefix), cursor });
          for (const k of page.keys) {
            const value = await ns.get(k.name, "json");
            yield { key: kvUnkey(k.name), value: (value ?? null) as T | null };
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      },
    }),
  };
}

// Bound from env on every fetch; Workers guarantees a single event loop per
// isolate, so module-level state is safe (and is what makes the memos below
// worth having).
let kv!: KvLike;
let aaApiKey = "";

// ---------------------------------------------------------------------------
// KV keys
// ---------------------------------------------------------------------------

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
// Artificial Analysis v2 bulk over CloudPrice
// Free tier: 100 req/day is plenty for 1 paginated bulk/day cached in KV.
// Needs AA_API_KEY env (server-side only, never exposed to the browser).
// When missing, we silently fall back to CloudPrice-only.
//
// Since the Nov 2026 retirement of /data/* we read /language/models/free.
// That free shape carries only the Intelligence Index among our benchmarks
// (per-benchmark scores and creator slugs are Pro-only), so AA overlays its
// fresher index values on rows CloudPrice still fills; coverage (aaCoveredIds)
// is full-row only and is therefore empty on the free tier.
// ---------------------------------------------------------------------------

const AA_BASE = "https://artificialanalysis.ai/api/v2";
const AA_BULK_TTL_MS = 24 * 60 * 60 * 1000;
// The bulk is paginated (200/page). The cap exists only so a stuck
// `has_more` cannot loop the fetch forever; the catalog is ~1000 models.
const AA_MAX_PAGES = 50;
// The full AA catalog (~1000 models with pricing/performance) is far more
// than the leaderboard needs, so we persist only the compact per-Go-model
// subset, one small key per model. Per-model keys also make concurrent tick
// writes conflict-free: a single combined key would be a read-modify-write
// race when two tabs tick at once.
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
  // Vendor of the model, e.g. { id, name: "Anthropic" } on the current v2
  // bulk (creator slug is Pro-only; aaCreatorSlug derives one from the name).
  // This is the creator source: present on every model in the bulk payload.
  model_creator?: AaCreator;
  evaluations?: Record<string, number | null>;
};

type AaCreator = {
  id?: string;
  name?: string;
  // Only on KV shards written before the v2 migration; new payloads have no slug.
  slug?: string;
};

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

// Creator slug of an AA model. The pre-migration payload shipped `slug`
// directly; the current v2 free shape only has `name`, so derive the same
// shape from it ("Z AI" -> "z-ai").
function aaCreatorSlug(m: AaBulkModel): string {
  const c = m.model_creator;
  if (!c) return "";
  return c.slug ?? creatorSlug(c.name ?? "");
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
  const apiKey = aaApiKey;
  if (!apiKey) return null;
  if (!force) {
    const cached = await loadAaShard();
    if (cached) return cached;
  }
  console.log("[build] fetching AA bulk...");
  // Paginated since the v2 migration: collect every page before building the
  // index, or matching and the rank-percentile distributions would silently
  // truncate to the first 200 models.
  const models: AaBulkModel[] = [];
  for (let page = 1; page <= AA_MAX_PAGES; page++) {
    const d = (await fetchJson(
      `${AA_BASE}/language/models/free?page=${page}`,
      TICK_BUDGET_MS,
      { "x-api-key": apiKey },
    )) as {
      data?: AaBulkModel[];
      pagination?: { has_more?: boolean };
    };
    const batch = d?.data ?? [];
    models.push(...batch);
    // An empty page also stops the loop: a broken has_more must not spin.
    if (!batch.length || !d?.pagination?.has_more) break;
  }
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
    // Delete when empty: the pre-migration payload had values for every
    // benchmark, and a dist left behind would keep overriding percentiles
    // for one the free shape no longer supplies.
    if (vals.length) await kv.set(kvAaDistKey(b.slug), vals);
    else await kv.delete(kvAaDistKey(b.slug));
  }
  // Persist only Go-matched compact models (tiny keys, one write per model).
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
  // `withValues` is the free tier's real contribution: the free shape ships
  // every evaluation key, but mostly null. When it drops to 0 the bulk is
  // effectively creator-seeding only, which is the signal to reconsider it.
  const withValues = models.filter((m) =>
    Object.keys(aaValuesFor(m).value).length > 0
  ).length;
  console.log(
    `[build] AA bulk: ${models.length} total, ${withValues} with eval values, ${matched.length}/${goIds.length} Go matched, ${stored} shard keys + dists stored`,
  );
  return matched;
}

type AaData = {
  idx: Map<string, AaBulkModel>;
  dists: Record<string, number[]> | null;
};

// Models whose whole row AA can answer: every wanted benchmark has a value,
// so a CloudPrice tick would add nothing. Coverage used to mean "any" wanted
// value, which was equivalent under the old bulk payload (it carried the full
// evaluation set); on the free-tier shape AA only has the Intelligence Index,
// and "any" would exclude every model from CloudPrice ticks while 8 of 9
// columns stayed empty. Partially covered models still tick and get their
// missing benchmarks from CloudPrice, with AA overwriting where it has data.
function aaCoveredIds(idx: Map<string, AaBulkModel>, goIds: string[]): Set<string> {
  const covered = new Set<string>();
  for (const id of goIds) {
    const hit = lookupAa(idx, id);
    if (!hit) continue;
    const value = aaValuesFor(hit).value;
    if (BENCHMARKS.every((b) => typeof value[b.slug] === "number")) {
      covered.add(id);
    }
  }
  return covered;
}

// In-isolate memo (see MEMO_TTL_MS). Loading the shard is a KV list plus
// per-key reads, and getAaData runs on every page load AND every tick, so
// memoizing it is what keeps steady-state KV usage near zero. The refresh
// handler clears it after rewriting the shards.
let aaMemo: { data: AaData | null; at: number } | null = null;

function invalidateAaMemo(): void {
  aaMemo = null;
}

async function getAaData(
  goIds: string[] = [],
): Promise<AaData | null> {
  if (aaMemo && Date.now() - aaMemo.at < MEMO_TTL_MS) return aaMemo.data;
  if (!aaApiKey) return null;
  let data: AaData | null = null;
  try {
    const cached = await loadAaShard();
    if (cached) {
      data = { idx: buildAaIndex(cached), dists: await loadAaDists() };
    } else {
      const models = await fetchAaBulk(false, goIds);
      if (models) data = { idx: buildAaIndex(models), dists: await loadAaDists() };
    }
  } catch (e) {
    console.log(`[build] AA bulk failed, fallback to CloudPrice: ${(e as Error).message}`);
    const cached = await loadAaShard();
    if (cached) {
      data = { idx: buildAaIndex(cached), dists: await loadAaDists() };
    }
  }
  aaMemo = { data, at: Date.now() };
  return data;
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
//
// `initial` skips the KV read: right after ?refresh=1 clears the key, a
// read-back can resurrect the pre-refresh state (Workers KV reads go stale
// after a write), and this request's own todo list must be computed from the
// cleared state instead.
async function seedCreatorsFromAa(
  goIds: string[],
  idx: Map<string, AaBulkModel> | null,
  initial?: CreatorState,
): Promise<CreatorState> {
  const state = initial ?? await loadCreatorState();
  if (!idx) return state;
  let changed = false;
  for (const id of goIds) {
    if (state.creators[id]) continue;
    const hit = lookupAa(idx, id);
    const slug = hit ? aaCreatorSlug(hit) : "";
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

// Resolve ONE specific model's creator, keeping the tick's
// one-CloudPrice-call-per-request invariant. `handled: false` means "spend the
// next tick on the same id" (rate limit, transient error, or an ambiguous
// answer whose exact-id retry has just been armed) — the model stays pending.
async function tickCreatorFor(
  goIds: string[],
  aaIdx: Map<string, AaBulkModel> | null,
  id: string,
  initial?: CreatorState,
): Promise<{
  handled: boolean;
  creator: string | null;
  retryAfterMs: number | null;
}> {
  // Seed from AA first: a manual refresh drops the memo, and without this the
  // models AA already covers would each cost a CloudPrice call.
  const state = initial ?? await seedCreatorsFromAa(goIds, aaIdx);
  const pending = pendingCreatorModels(
    goIds,
    state.creators,
    state.families,
    state.retried,
  );
  if (!pending.includes(id)) {
    // Already settled (another request, or a family hint that now answers it):
    // no call spent, report the effective creator so the client drops its head.
    return {
      handled: true,
      creator: knownCreator(id, undefined, state.creators, state.families) ||
        null,
      retryAfterMs: null,
    };
  }

  const cpiId = state.pendingCandidate[id] ?? id;
  const r = await lookupCreator(cpiId);

  if (r.kind === "rateLimited") {
    // Nothing persisted: the model stays pending and the client waits out the
    // retry-after.
    return { handled: false, creator: null, retryAfterMs: r.retryAfterMs };
  }
  if (r.kind === "error") {
    // Transient failure. Unlike a 404 this says nothing about the model, so
    // keep it pending and retry later instead of blanking the Creator column
    // for a week (what markCreatorEmpty would cost).
    return { handled: false, creator: null, retryAfterMs: 5000 };
  }

  let outcome: string;
  let retryNext = false;
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
      // the second ambiguous answer falls through to empty below. Not handled
      // yet: the client keeps the id at its queue head and the next tick
      // spends its slot on that exact id.
      state.pendingCandidate[id] = r.candidates[0];
      outcome = "ambiguous, retrying exact id";
      retryNext = true;
    } else {
      markCreatorEmpty(state, id);
      outcome = "ambiguous";
    }
  } else {
    // 404: this id does not exist upstream, so there is no creator to show.
    // Carry it empty and retry once at the next manual refresh.
    markCreatorEmpty(state, id);
    outcome = r.kind;
  }

  await saveCreatorState(state);
  console.log(
    `[creator] ${id} -> ${state.creators[id] || "(empty)"} via ${cpiId} (${outcome})`,
  );
  if (retryNext) {
    return { handled: false, creator: null, retryAfterMs: null };
  }
  return {
    handled: true,
    creator: knownCreator(id, undefined, state.creators, state.families) || null,
    retryAfterMs: null,
  };
}

// Legacy picker (no explicit target in the request): resolve the first pending
// model, so an old cached index.js still converges one creator per tick.
async function tickCreator(
  goIds: string[],
  aaIdx: Map<string, AaBulkModel> | null,
): Promise<{
  touched: boolean;
  handled: boolean;
  id: string | null;
  retryAfterMs: number | null;
}> {
  const state = await seedCreatorsFromAa(goIds, aaIdx);
  const pending = pendingCreatorModels(
    goIds,
    state.creators,
    state.families,
    state.retried,
  );
  if (!pending.length) {
    return { touched: false, handled: false, id: null, retryAfterMs: null };
  }
  const id = pending[0];
  const r = await tickCreatorFor(goIds, aaIdx, id, state);
  return { touched: true, handled: r.handled, id, retryAfterMs: r.retryAfterMs };
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
      // expired. Age the snapshot instead of deleting it: a stale entry is due
      // for a refetch on the next request, but fetchGoLimits() still falls back
      // to it when that fetch fails. Deleting meant a single upstream 404 right
      // after a model was added blanked Req/mo and Value for every row.
      const staleLimits = await kv.get<GoLimits>(KV_GO_LIMITS);
      if (staleLimits.value) {
        await kv.set(KV_GO_LIMITS, {
          ...staleLimits.value,
          fetchedAt: Date.now() - GO_LIMITS_TTL_MS,
        });
      }
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
// The cycle's todo list
// ---------------------------------------------------------------------------
// Computed ONCE per page render and handed to the client, which ticks through
// it. Asking KV "what is still pending?" on every tick looked at reads right
// after this loop's own writes, and Workers KV serves those stale for up to a
// minute — the status line kept counting the same model and CloudPrice was
// asked for it ~10 times in a row. Recomputing is only done by the legacy
// fallback in tick() (no `next`/`resolveCreator` param), for old cached JS.

async function loadModelEntries(): Promise<Map<string, CachedModel>> {
  const entries = new Map<string, CachedModel>();
  const it = kv.list<CachedModel>({ prefix: ["model"] });
  for await (const entry of it) {
    const id = String(entry.key[1]);
    if (entry.value) entries.set(id, entry.value);
  }
  return entries;
}

type PendingLists = { pendingCreators: string[]; pendingBuild: string[] };

function pendingLists(
  goIds: string[],
  opts: {
    covered: Set<string>;
    creatorState: CreatorState;
    refreshAt: number;
    entries: Map<string, CachedModel>;
    now?: number;
  },
): PendingLists {
  const now = opts.now ?? Date.now();
  const pendingCreators = pendingCreatorModels(
    goIds,
    opts.creatorState.creators,
    opts.creatorState.families,
    opts.creatorState.retried,
  );
  const pendingBuild: string[] = [];
  for (const id of goIds) {
    // AA-covered models resolve via bulk, never via ticks.
    if (opts.covered.has(id)) continue;
    const cached = opts.entries.get(id);
    if (!cached) {
      pendingBuild.push(id);
      continue;
    }
    // Revalidate everything older than this refresh epoch, plus everything
    // that has aged past the auto-refresh window.
    if (cached.fetchedAt < opts.refreshAt) {
      pendingBuild.push(id);
      continue;
    }
    if (now - cached.fetchedAt >= STALE_TTL_MS) pendingBuild.push(id);
  }
  return { pendingCreators, pendingBuild };
}

function remainingOf(p: PendingLists): number {
  return p.pendingCreators.length + p.pendingBuild.length;
}

// `remaining` after `id` was handled. Computed from the pre-write snapshot:
// reading KV back after the write is exactly the stale read this design exists
// to avoid.
function remainingAfter(p: PendingLists, id: string | null): number {
  if (!id) return remainingOf(p);
  const inCreators = p.pendingCreators.includes(id);
  const inBuild = p.pendingBuild.includes(id);
  return remainingOf(p) - (inCreators || inBuild ? 1 : 0);
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
  // The cycle's todo list, embedded in BUILD for the client to tick through
  // (see "The cycle's todo list" above).
  pendingCreators: string[];
  pendingBuild: string[];
  // Refresh epoch for this page, echoed back on tick requests: a tick landing
  // on another machine can still read the pre-refresh KV_GO_REFRESH, and
  // without the echo the refetch it was asked for would be skipped as "fresh".
  refreshAt: number;
  retryAfterMs: number | null;
};

async function assembleBuild(
  goIds: string[],
  opts: {
    // In-memory refresh epoch / creator state: passed by the ?refresh=1
    // handler, which just wrote them and must not read them back (stale).
    refreshAt?: number;
    creatorState?: CreatorState;
  } = {},
): Promise<BuildState> {
  // Load any Go limits we already have; never fetch them in the hot path.
  // The in-isolate memo first: right after ?refresh=1 writes the snapshot,
  // the KV read-back can serve the pre-refresh copy (Workers KV), so the
  // just-refreshed limits would miss this one render. The memo holds the very
  // values that request wrote, or something fetched within MEMO_TTL_MS.
  let goLimits: Record<string, GoLimit> = {};
  if (limitsMemo && Date.now() - limitsMemo.at < MEMO_TTL_MS) {
    goLimits = limitsMemo.limits;
  } else {
    const limitsEntry = await kv.get<GoLimits>(KV_GO_LIMITS);
    if (limitsEntry.value) goLimits = limitsEntry.value.limits;
  }

  const entries = await loadModelEntries();

  // AA overlays fresher values (on the free tier: the Intelligence Index) and
  // rank percentiles from catalog distributions; CloudPrice KV fills every
  // benchmark AA does not have, and provides percentiles where no catalog
  // distribution exists.
  const aaData = await getAaData(goIds);
  const aaIdx = aaData?.idx ?? null;
  const aaDists = aaData?.dists ?? null;
  const covered = aaIdx ? aaCoveredIds(aaIdx, goIds) : new Set<string>();

  const refreshAt = opts.refreshAt ??
    (await kv.get<number>(KV_GO_REFRESH)).value ?? 0;

  // Memoized first-word -> creator. Also seeds every token AA covers, so most
  // tokens never need a CloudPrice call.
  const creatorState = await seedCreatorsFromAa(goIds, aaIdx, opts.creatorState);
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
        aaCreator = aaCreatorSlug(hit);
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

  const lists = pendingLists(goIds, { covered, creatorState, refreshAt, entries });

  console.log(
    `[tick] assemble: ${matchedCount}/${goIds.length} matched, ${remainingOf(lists)} pending (creators=${lists.pendingCreators.length} build=${lists.pendingBuild.length}), aaFilled=${aaFilled}, aaPct=${aaPctFilled}, emptyReasons=${JSON.stringify(emptyReasons)}, aa=${aaIdx ? "on" : "off"}, limits=${limitsCount}/${goIds.length} noLimits=[${noLimits.join(",")}]`,
  );

  return {
    rows,
    benchmarks: BENCHMARKS,
    updatedAt: new Date().toISOString(),
    remaining: remainingOf(lists),
    pendingCreators: lists.pendingCreators,
    pendingBuild: lists.pendingBuild,
    refreshAt,
    retryAfterMs: null,
  };
}

// ---------------------------------------------------------------------------
// Tick: do exactly one unit of work, persist it, report progress
// ---------------------------------------------------------------------------
// A model fully covered by AA never needs CloudPrice: its values and rank
// percentiles come from the bulk, and re-ticking it would overwrite fresher
// data with the lagging snapshot. AA-misses (on the free tier, everything
// below full coverage) tick as if there were no AA key. Without an AA key,
// all models tick.
//
// The modern client names the unit of work (`target`: see the handler), so a
// tick never picks its target by scanning KV — and `remaining` is always
// derived from the pre-write snapshot in `lists`, never from a read-back.
// Clients without a queue fall into the legacy scan below.

type TickTarget = {
  // Model whose benchmarks should be fetched this tick.
  next?: string;
  // Model whose creator should be resolved this tick.
  resolveCreator?: string;
  // Refresh epoch echoed from the page (see BuildState.refreshAt).
  refreshAt?: number;
};

type TickResult = {
  // True when the requested unit of work is complete and the client should
  // drop it from its queue (fetched / empty / already fresh / creator
  // settled). False on rate limits and transient failures: the head stays.
  handled: boolean;
  kind: "fetched" | "empty" | "creator" | "noop";
  id: string | null;
  creator?: string | null;
  value?: Record<string, number>;
  percentile?: Record<string, number>;
  remaining: number;
  retryAfterMs: number | null;
  // Legacy field for pre-queue clients (old cached index.js): they only know
  // to patch a row when `fetched && id && value`.
  fetched: boolean;
};

// One CloudPrice fetch + its KV write, folded into a response fragment.
// Shared by the targeted path and the legacy scan so both report identically.
async function fetchAndStore(
  id: string,
): Promise<
  | { kind: "fetched"; value: Record<string, number>; percentile: Record<string, number> }
  | { kind: "empty" }
  | { kind: "retry"; retryAfterMs: number | null }
> {
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
      const v = !isNaN(recomputed) ? recomputed : r.data.percentile[k];
      if (typeof v === "number") pct[k] = v;
    }
    return { kind: "fetched", value: r.data.value, percentile: pct };
  }
  if (r.kind === "empty") {
    await kv.set(kvModelKey(id), {
      empty: true,
      fetchedAt: Date.now(),
      reason: r.reason,
      sourcesCount: r.sourcesCount,
    });
    console.log(`[tick] recorded empty for ${id} reason=${r.reason}`);
    return { kind: "empty" };
  }
  if (r.kind === "rateLimited") {
    console.log(`[tick] 429 on ${id}, retry in ${r.retryAfterMs}ms`);
    return { kind: "retry", retryAfterMs: r.retryAfterMs };
  }
  // Transient failure. Hand the backoff to the client instead of sleeping out
  // the tick budget: the client waits it out (floor 10s), so the API isn't
  // hammered either way, and the id stays at the head of its queue.
  return { kind: "retry", retryAfterMs: 5000 };
}

async function tick(
  goIds: string[],
  deadlineMs: number,
  target: TickTarget = {},
): Promise<TickResult> {
  const kvRefreshAt = (await kv.get<number>(KV_GO_REFRESH)).value ?? 0;
  // The page that started a refresh echoes its epoch: a tick landing on
  // another machine can read the pre-refresh KV_GO_REFRESH for up to a minute,
  // which would skip the refetch it was asked for as "fresh". Clamped to now
  // so a bogus client value can only force refetches of ids already queued.
  const echoed = Number(target.refreshAt);
  const reqRefreshAt = Number.isFinite(echoed) && echoed > 0
    ? Math.min(echoed, Date.now())
    : 0;
  const refreshAt = Math.max(kvRefreshAt, reqRefreshAt);

  const aaIdx = await getAaIndex(goIds);
  const covered = aaIdx ? aaCoveredIds(aaIdx, goIds) : new Set<string>();
  const creatorState = await seedCreatorsFromAa(goIds, aaIdx);
  const entries = await loadModelEntries();
  const lists = pendingLists(goIds, { covered, creatorState, refreshAt, entries });

  const handled = (
    kind: TickResult["kind"],
    id: string | null,
    extra: Partial<TickResult> = {},
  ): TickResult => ({
    handled: true,
    kind,
    id,
    remaining: remainingAfter(lists, id),
    retryAfterMs: null,
    fetched: kind === "fetched",
    ...extra,
  });
  const backoff = (retryAfterMs: number | null): TickResult => ({
    handled: false,
    kind: "noop",
    id: null,
    remaining: remainingOf(lists),
    retryAfterMs,
    fetched: false,
  });

  // --- Creator target ------------------------------------------------------
  if (target.resolveCreator !== undefined) {
    const id = target.resolveCreator;
    if (!goIds.includes(id)) return handled("noop", null);
    const r = await tickCreatorFor(goIds, aaIdx, id, creatorState);
    if (!r.handled) return backoff(r.retryAfterMs);
    return handled("creator", id, { creator: r.creator });
  }

  // --- Benchmark target ----------------------------------------------------
  if (target.next !== undefined) {
    const id = target.next;
    // The queue came from an earlier render: if AA now covers the id, or it
    // left the Go list, or another tab already refetched it, there is nothing
    // to spend a call on — report done so the client pops the head.
    if (!goIds.includes(id) || covered.has(id)) return handled("noop", null);
    const cached = entries.get(id);
    const now = Date.now();
    if (
      cached && cached.fetchedAt >= refreshAt &&
      now - cached.fetchedAt < STALE_TTL_MS
    ) {
      return handled("noop", id);
    }
    if (now > deadlineMs) return backoff(null);
    const r = await fetchAndStore(id);
    if (r.kind === "retry") return backoff(r.retryAfterMs);
    if (r.kind === "empty") return handled("empty", id);
    return handled("fetched", id, { value: r.value, percentile: r.percentile });
  }

  // --- Legacy client (no queue params) ------------------------------------
  // One unit of work per request, chosen by scanning KV. Kept so an old
  // cached index.js (max-age 1h) still drives a build to completion.
  const creator = await tickCreator(goIds, aaIdx);
  if (creator.touched) {
    return {
      handled: creator.handled,
      kind: "creator",
      id: null,
      remaining: creator.handled && creator.id
        ? remainingAfter(lists, creator.id)
        : remainingOf(lists),
      retryAfterMs: creator.retryAfterMs,
      fetched: false,
    };
  }

  for (const id of goIds) {
    if (Date.now() > deadlineMs) break;

    // AA-covered models never need CloudPrice (values + percentiles from AA).
    if (covered.has(id)) continue;

    const cached = entries.get(id);
    // Skip fresh entries, unless a manual refresh asked for revalidation.
    // Old data stays visible until the refetch succeeds (stale-while-revalidate).
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (cached.fetchedAt >= refreshAt && age < STALE_TTL_MS) continue;
    }

    const r = await fetchAndStore(id);
    if (r.kind === "retry") return backoff(r.retryAfterMs);
    if (r.kind === "empty") return handled("empty", id);
    return handled("fetched", id, { value: r.value, percentile: r.percentile });
  }
  return backoff(null);
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

function renderHtml(data: BuildState): string {
  const { rows, benchmarks } = data;
  const rowJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  const benchJson = JSON.stringify(benchmarks).replace(/</g, "\\u003c");
  // BUILD carries the cycle's todo list and the refresh epoch the client
  // echoes back on ticks (see BuildState).
  const buildJson = JSON.stringify(
    {
      remaining: data.remaining,
      retryAfterMs: data.retryAfterMs,
      pendingCreators: data.pendingCreators,
      pendingBuild: data.pendingBuild,
      refreshAt: data.refreshAt,
    },
  ).replace(/</g, "\\u003c");
  return HTML_PAGE
    .replace("__updatedAt__", escapeHtml(data.updatedAt))
    .replace("__rowJson__", rowJson)
    .replace("__benchJson__", benchJson)
    .replace("__buildJson__", buildJson);
}

function serveHtml(data: BuildState): Response {
  return new Response(renderHtml(data), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page embeds KV-backed state and the todo list for a running
      // refresh; max-age=60 used to serve a pre-refresh page from the browser
      // right after a refresh finished (and the final tick-driven reload
      // picked it up too). must-revalidate keeps every view fresh.
      "cache-control": "no-cache, must-revalidate",
    },
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Tick/debug responses are read on a tight poll loop and drive queue
      // decisions; a cached GET would replay a stale `remaining` and stall or
      // duplicate work.
      "cache-control": "no-store",
    },
  });

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Static files.
  if (url.pathname === "/index.js") {
    return new Response(CLIENT_JS, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  // Shared tick-queue helpers (imported by index.js as a module). Not URL-
  // versioned like index.js, so it revalidates on every load instead: a stale
  // copy paired with a fresh index.js would silently desync the queues.
  if (url.pathname === "/queue.js") {
    return new Response(QUEUE_JS, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      },
    });
  }
  if (url.pathname === "/index.css") {
    return new Response(CLIENT_CSS, {
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

    // Tick request: do one unit of work, bounded in time. The modern client
    // names the work (next/resolveCreator) and counts its own queue down;
    // without a target we fall back to the legacy KV scan.
    if (url.searchParams.get("tick") === "1") {
      const numParam = (name: string): number | undefined => {
        const v = Number(url.searchParams.get(name));
        return Number.isFinite(v) && v > 0 ? v : undefined;
      };
      const result = await tick(goIds, Date.now() + TICK_BUDGET_MS, {
        next: url.searchParams.get("next") ?? undefined,
        resolveCreator: url.searchParams.get("resolveCreator") ?? undefined,
        refreshAt: numParam("refreshAt"),
      });
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
              creator: aaCreatorSlug(aaHit) || null,
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
      const refreshAt = Date.now();
      await kv.set(KV_GO_REFRESH, refreshAt);
      await kv.set(KV_GO_CHECKED, refreshAt);
      // Drop memoized creators so ticks re-resolve them; AA re-seeds the
      // tokens it covers for free. A write, not a delete: the state below is
      // the one this request's todo list is computed from, and reading a
      // delete back (Workers KV serves post-write reads stale) resurrected
      // the pre-refresh retried map and shrank the queue.
      const clearedCreators: CreatorState = {
        creators: {},
        families: {},
        pendingCandidate: {},
        retried: {},
      };
      await kv.set(KV_CREATORS, clearedCreators);
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
      // Shards and dists were rewritten above: drop the in-isolate memo so
      // the assemble below reads the fresh state.
      invalidateAaMemo();
      goIds = live;

      const state = await assembleBuild(goIds, {
        refreshAt,
        creatorState: clearedCreators,
      });
      console.log(
        `[perf] assembleBuild ${(performance.now() - t2).toFixed(1)}ms`,
      );
      return serveHtml(state);
    }

    const state = await assembleBuild(goIds);
    console.log(`[perf] assembleBuild ${(performance.now() - t2).toFixed(1)}ms`);
    return serveHtml(state);
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

// Cloudflare Workers entry point. env carries the KV binding and secrets;
// binding them per-request replaces both Deno.openKv() (top-level await) and
// Deno.env, and lets wrangler dev inject .dev.vars locally.
export default {
  fetch(req: Request, env: WorkerEnv): Promise<Response> {
    kv = workersKv(env.KV);
    aaApiKey = env.AA_API_KEY ?? "";
    return handler(req);
  },
};