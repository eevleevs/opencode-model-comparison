// OpenCode Go Model Leaderboard
// Fetches the latest models available on OpenCode Go, their utilization limits
// (from the Go docs), and coding benchmarks (from CloudPrice), then ranks them
// by a "value" score = benchmark performance × requests per month.
//
// Deno Deploy is serverless: isolates idle-shutdown and requests that run too
// long are killed (502). So NO request ever does more than one CloudPrice call.
// Benchmark results are persisted per-model in KV as soon as each one is
// fetched; the page always renders whatever is in KV immediately. A client
// polls GET /?tick=1 (one model fetch per tick) until the leaderboard is full.
//
// Deploy: `deno run --allow-net --allow-read --unstable-kv main.ts`

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

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "opencode-go-leaderboard/1.0" },
      signal: ac.signal,
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const secs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : 10;
      throw new RateLimitedError(secs * 1000);
    }
    if (!res.ok) throw new HttpError(res.status, `GET ${url} -> ${res.status}`);
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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Markdown table parser (for Go docs limits)
// ---------------------------------------------------------------------------

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdownTables(
  text: string,
): Map<string, { headers: string[]; rows: string[][] }> {
  const tables = new Map<string, { headers: string[]; rows: string[][] }>();
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
        tables.set(headers.join("|"), { headers, rows });
      }
    } else {
      i++;
    }
  }
  return tables;
}

function findTable(
  tables: Map<string, { headers: string[]; rows: string[][] }>,
  headerMatch: string,
) {
  for (const [, table] of tables) {
    if (table.headers.some((h) => h.includes(headerMatch))) {
      return table;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Go utilization limits (from docs MDX)
// ---------------------------------------------------------------------------

type GoLimits = {
  limits: Record<
    string,
    { reqPer5h: number; reqPerWeek: number; reqPerMonth: number }
  >;
  fetchedAt: number;
};

const GO_LIMITS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchGoLimits(
  forceRefresh = false,
): Promise<GoLimits["limits"]> {
  const kvKey = ["go-limits"];
  if (!forceRefresh) {
    const entry = await kv.get<GoLimits>(kvKey);
    if (entry.value && Date.now() - entry.value.fetchedAt < GO_LIMITS_TTL_MS) {
      return entry.value.limits;
    }
  }
  console.log("[build] fetching Go docs MDX...");
  const res = await fetch(GO_DOCS_URL, {
    headers: { "user-agent": "opencode-go-leaderboard/1.0" },
  });
  if (!res.ok) throw new Error(`GET ${GO_DOCS_URL} -> ${res.status}`);
  const mdx = await res.text();
  const tables = parseMarkdownTables(mdx);
  const endpointsTable = findTable(tables, "Model ID");
  const requestsTable = findTable(tables, "requests per 5 hour");
  if (!endpointsTable || !requestsTable) {
    throw new Error("Failed to parse Go docs tables");
  }
  const displayNameToId = new Map<string, string>();
  for (const row of endpointsTable.rows) {
    const displayName = row[0];
    const modelId = row[1];
    if (displayName && modelId) displayNameToId.set(displayName, modelId);
  }
  const limits: GoLimits["limits"] = {};
  for (const row of requestsTable.rows) {
    const displayName = row[0];
    const reqPer5h = parseInt(row[1]?.replace(/,/g, ""), 10);
    const reqPerWeek = parseInt(row[2]?.replace(/,/g, ""), 10);
    const reqPerMonth = parseInt(row[3]?.replace(/,/g, ""), 10);
    const id = displayNameToId.get(displayName);
    if (id && !isNaN(reqPer5h) && !isNaN(reqPerWeek) && !isNaN(reqPerMonth)) {
      limits[id] = { reqPer5h, reqPerWeek, reqPerMonth };
    }
  }
  console.log(
    `[build] parsed ${Object.keys(limits).length} model limits from Go docs`,
  );
  await kv.set(kvKey, { limits, fetchedAt: Date.now() });
  return limits;
}

// ---------------------------------------------------------------------------
// KV store
// ---------------------------------------------------------------------------

const kv = await Deno.openKv();
const KV_GO_IDS = ["go", "ids"];
const KV_GO_CHECKED = ["go", "checkedAt"];

function kvModelKey(id: string): string[] {
  return ["model", id];
}

// ---------------------------------------------------------------------------
// Per-model benchmark fetch
// ---------------------------------------------------------------------------

type CpiScore = { metric: string; value?: number; percentile?: number };
type CpiSource = { scores?: CpiScore[] };
type CpiPayload = { data?: { sources?: CpiSource[] } };

type ModelData = {
  value: Record<string, number>;
  percentile: Record<string, number>;
};

type CachedModel =
  | { data: ModelData; fetchedAt: number }
  | { empty: true; fetchedAt: number };

// One CloudPrice call for a single model. No retry-sleeping: 429/timeout fold
// into a "not yet" result and the client retries a later tick.
async function fetchModelOnce(
  id: string,
): Promise<{ kind: "ok"; data: ModelData } | { kind: "empty" } | {
  kind: "rateLimited";
  retryAfterMs: number;
} | { kind: "error" }> {
  try {
    const d = (await fetchJson(
      `${CLOUDPRICE}/models/${id}/benchmarks`,
      TICK_BUDGET_MS,
    )) as CpiPayload;
    const srcs = d?.data?.sources ?? [];
    if (!srcs.length) return { kind: "empty" };
    const value: Record<string, number> = {};
    const percentile: Record<string, number> = {};
    for (const src of srcs) {
      for (const s of src.scores ?? []) {
        if (typeof s.value === "number") value[s.metric] = s.value;
        if (typeof s.percentile === "number") {
          percentile[s.metric] = s.percentile;
        }
      }
    }
    const data: ModelData = { value, percentile };
    if (Object.keys(value).length === 0) return { kind: "empty" };
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof RateLimitedError) {
      console.log(`[tick] 429 on ${id}, retry in ${e.retryAfterMs}ms`);
      return { kind: "rateLimited", retryAfterMs: e.retryAfterMs };
    }
    if (e instanceof HttpError && (e.status === 404 || e.status === 409)) {
      console.log(`[tick] ${id} has no public benchmarks (${e.status})`);
      return { kind: "empty" };
    }
    console.log(`[tick] fetch failed for ${id}: ${(e as Error).message}`);
    return { kind: "error" };
  }
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
  let goLimits: Record<
    string,
    { reqPer5h: number; reqPerWeek: number; reqPerMonth: number }
  > = {};
  const limitsEntry = await kv.get<GoLimits>(["go-limits"]);
  if (limitsEntry.value) goLimits = limitsEntry.value.limits;

  const entries = new Map<string, CachedModel>();
  const it = kv.list<CachedModel>({ prefix: ["model"] });
  for await (const entry of it) {
    const id = String(entry.key[1]);
    if (entry.value) entries.set(id, entry.value);
  }

  const rows: Row[] = [];
  let matchedCount = 0;

  for (const id of goIds) {
    const limits = goLimits[id] ?? null;
    const cached = entries.get(id);

    const benchmarks: Record<string, number | null> = {};
    const percentiles: Record<string, number | null> = {};
    let matchedAny = false;

    if (cached && "data" in cached) {
      const data = cached.data;
      for (const b of BENCHMARKS) {
        benchmarks[b.slug] = data.value[b.slug] ?? null;
        percentiles[b.slug] = data.percentile[b.slug] ?? null;
        if (benchmarks[b.slug] != null) matchedAny = true;
      }
    } else {
      for (const b of BENCHMARKS) {
        benchmarks[b.slug] = null;
        percentiles[b.slug] = null;
      }
    }

    const parts = id.split(/[-.]/);
    const creator = parts.length > 1 ? parts[0] : "";

    if (matchedAny) matchedCount++;

    rows.push({
      id,
      name: id,
      creator,
      reqPer5h: limits?.reqPer5h ?? null,
      reqPerWeek: limits?.reqPerWeek ?? null,
      reqPerMonth: limits?.reqPerMonth ?? null,
      benchmarks,
      percentiles,
      matched: matchedAny,
    });
  }

  const remaining = await countPending(goIds);

  console.log(
    `[tick] assemble: ${matchedCount}/${goIds.length} matched, ${remaining} pending`,
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
  for (const id of goIds) {
    if (Date.now() > deadlineMs) break;

    const cached = await kv.get<CachedModel>(kvModelKey(id));
    // Skip models that already have fresh benchmark data or a fresh tombstone.
    if (cached.value) {
      const age = Date.now() - cached.value.fetchedAt;
      if (age < STALE_TTL_MS) continue;
    }

    const r = await fetchModelOnce(id);
    if (r.kind === "ok") {
      await kv.set(kvModelKey(id), {
        data: r.data,
        fetchedAt: Date.now(),
      });
      console.log(`[tick] fetched ${id}`);
      return {
        fetched: true,
        id,
        value: r.data.value,
        percentile: r.data.percentile,
        remaining: await countPending(goIds),
        retryAfterMs: null,
      };
    }
    if (r.kind === "empty") {
      await kv.set(kvModelKey(id), { empty: true, fetchedAt: Date.now() });
      console.log(`[tick] recorded empty for ${id}`);
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

async function countPending(goIds: string[]): Promise<number> {
  let remaining = 0;
  for (const id of goIds) {
    const cached = await kv.get<CachedModel>(kvModelKey(id));
    if (!cached.value) {
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
    const goIds = await ensureGoIds();
    const t1 = performance.now();
    console.log(`[perf] ensureGoIds ${(t1 - t0).toFixed(1)}ms`);
    if (await kv.get(["go-limits"]).then((e) => !e.value)) {
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

    // Hard refresh: re-fetch the Go model list, drop only removed models,
    // and reset the checkedAt so ticks re-fetch stale data for the rest.
    if (url.searchParams.get("refresh") === "1") {
      console.log("[build] manual refresh requested");
      const live = await getGoModelIds();
      const cached = await kv.get<string[]>(KV_GO_IDS);
      const liveSet = new Set(live);
      const removed = (cached.value ?? []).filter((id) => !liveSet.has(id));
      for (const id of removed) await kv.delete(kvModelKey(id));
      await kv.set(KV_GO_IDS, live);
      await kv.delete(KV_GO_CHECKED);
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
Deno.serve({ port: PORT }, handler);
export default handler;