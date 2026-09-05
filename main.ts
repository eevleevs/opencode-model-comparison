// OpenCode Go Model Leaderboard
// Fetches the latest models available on OpenCode Go, their utilization limits
// (from the Go docs), and coding benchmarks (from CloudPrice), then ranks them
// by a "value" score = benchmark performance × requests per month.
//
// KV stores the leaderboard permanently. A background refresh fetches models
// one at a time (2 s cadence) so CloudPrice never gets hammered. The refresh
// auto-triggers when the Go model list changes.
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
const REQ_TIMEOUT_MS = 20000;

// Seconds between API calls during a background refresh.
const CADENCE_MS = 2000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string, attempts = 4): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "opencode-go-leaderboard/1.0" },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 && i < attempts - 1) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10000)
          : 2000 * 2 ** i;
        console.log(
          `[fetch] 429 on ${url}, retry in ${delay}ms (attempt ${
            i + 1
          }/${attempts})`,
        );
        await sleep(delay);
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e instanceof DOMException && e.name === "AbortError") break;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr ?? new Error(`GET ${url} failed`);
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
const KV_LEADERBOARD = ["leaderboard", "data"];
const KV_GO_IDS = ["go-models", "ids"];
const KV_REFRESH_LOCK = ["refresh", "running"];

// ---------------------------------------------------------------------------
// Per-model benchmark fetch
// ---------------------------------------------------------------------------

type CpiScore = { metric: string; value?: number; percentile?: number };
type CpiSource = { scores?: CpiScore[] };
type CpiPayload = { data?: { sources?: CpiSource[] } };

type ModelResult = {
  value: Record<string, number>;
  percentile: Record<string, number>;
};

async function fetchModelBenchmarks(id: string): Promise<ModelResult | null> {
  try {
    const d =
      (await fetchJson(`${CLOUDPRICE}/models/${id}/benchmarks`)) as CpiPayload;
    const srcs = d?.data?.sources ?? [];
    if (!srcs.length) return null;
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
    return { value, percentile };
  } catch (e) {
    console.log(`[build] no benchmarks for ${id}: ${(e as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Go model list helpers
// ---------------------------------------------------------------------------

async function getGoModelIds(): Promise<string[]> {
  const res = await fetchJson(OC_GO_MODELS_URL) as {
    data: { id: string }[];
  };
  return res.data.map((m) => m.id);
}

async function hasGoModelsChanged(currentIds: string[]): Promise<boolean> {
  const cached = await kv.get<string[]>(KV_GO_IDS);
  if (!cached.value) return true;
  if (currentIds.length !== cached.value.length) return true;
  return !currentIds.every((id, i) => id === cached.value![i]);
}

// ---------------------------------------------------------------------------
// Build leaderboard from Go model IDs (sequential, optional cadence)
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

type BuildResult = {
  rows: Row[];
  benchmarks: typeof BENCHMARKS;
  updatedAt: string;
  notes: string[];
};

async function buildData(cadenceMs = 0): Promise<BuildResult> {
  const notes: string[] = [];

  // 1) Go model list.
  const ocIds = await getGoModelIds();

  // 2) Go utilization limits (KV-cached, 7-day TTL).
  let goLimits: Record<
    string,
    { reqPer5h: number; reqPerWeek: number; reqPerMonth: number }
  > = {};
  try {
    goLimits = await fetchGoLimits();
  } catch (e) {
    notes.push(`Go limits fetch failed: ${(e as Error).message}`);
  }

  // 3) Per-model benchmarks — one request per model, sequential.
  const cadenceLabel = cadenceMs ? ` (${cadenceMs / 1000}s cadence)` : "";
  console.log(
    `[build] fetching benchmarks for ${ocIds.length} models${cadenceLabel}...`,
  );

  const results: (ModelResult | null)[] = [];
  for (const id of ocIds) {
    if (cadenceMs > 0) await sleep(cadenceMs);
    results.push(await fetchModelBenchmarks(id));
  }

  // 4) Assemble rows.
  const rows: Row[] = [];
  let matchedCount = 0;

  for (let i = 0; i < ocIds.length; i++) {
    const id = ocIds[i];
    const limits = goLimits[id] ?? null;
    const r = results[i];

    const benchmarks: Record<string, number | null> = {};
    const percentiles: Record<string, number | null> = {};
    let matchedAny = false;
    if (r) {
      for (const b of BENCHMARKS) {
        benchmarks[b.slug] = r.value[b.slug] ?? null;
        percentiles[b.slug] = r.percentile[b.slug] ?? null;
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

  console.log(
    `[build] ${matchedCount}/${ocIds.length} models have at least one benchmark`,
  );
  for (const b of BENCHMARKS) {
    const count = rows.filter((r) => r.benchmarks[b.slug] != null).length;
    console.log(`[build] ${b.slug}: ${count} models with data`);
  }
  const unmatched = rows.length - matchedCount;
  if (unmatched > 0) {
    notes.push(
      `${unmatched} model(s) have no public benchmark yet (very new releases) and are listed without a score.`,
    );
  }

  return {
    rows,
    benchmarks: BENCHMARKS,
    updatedAt: new Date().toISOString(),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Background refresh — fire-and-forget, slow cadence
// ---------------------------------------------------------------------------

async function startBackgroundRefresh(
  goIds: string[],
  label = "auto",
): Promise<void> {
  const lock = await kv.get<boolean>(KV_REFRESH_LOCK);
  if (lock.value) {
    console.log(`[refresh] ${label}: already running, skipping`);
    return;
  }
  await kv.set(KV_REFRESH_LOCK, true);

  // Fire-and-forget: the handler returns immediately; this Promise continues
  // running in the event loop. On Deno Deploy the isolate stays alive long
  // enough for the slow build to finish (35 models × 2 s ≈ 70 s).
  (async () => {
    try {
      console.log(`[refresh] ${label}: starting for ${goIds.length} models`);
      const data = await buildData(CADENCE_MS);
      await kv.set(KV_LEADERBOARD, data);
      // Store model list AFTER leaderboard so interrupted builds re-trigger.
      await kv.set(KV_GO_IDS, goIds);
      console.log(
        `[refresh] ${label}: complete — ${
          data.rows.filter((r) => r.matched).length
        } models with benchmarks`,
      );
    } catch (e) {
      console.log(`[refresh] ${label}: failed — ${(e as Error).message}`);
    } finally {
      await kv.delete(KV_REFRESH_LOCK);
    }
  })();
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

const htmlTemplate = await Deno.readTextFile(
  new URL("./index.html", import.meta.url),
);

function renderHtml(data: BuildResult): string {
  const { rows, benchmarks, updatedAt, notes } = data;
  const rowJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  const benchJson = JSON.stringify(benchmarks).replace(/</g, "\\u003c");
  const noteHtml = notes.length
    ? `<ul class="notes">${
      notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")
    }</ul>`
    : "";
  return htmlTemplate!
    .replace("__updatedAt__", escapeHtml(updatedAt))
    .replace("__noteHtml__", noteHtml)
    .replace("__rowJson__", rowJson)
    .replace("__benchJson__", benchJson);
}

function serveHtml(data: BuildResult): Response {
  return new Response(renderHtml(data), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

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
    const css = await Deno.readTextFile(
      new URL("./index.css", import.meta.url),
    );
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

  const forceRefresh = url.searchParams.get("refresh") === "1";

  // Always try to serve cached data immediately.
  const cached = await kv.get<BuildResult>(KV_LEADERBOARD);

  if (cached.value) {
    // If refresh requested, fire off a background rebuild (non-blocking).
    if (forceRefresh) {
      getGoModelIds().then((ids) => startBackgroundRefresh(ids, "manual"))
        .catch(() => {});
    } else {
      // Check in background whether the Go model list has changed.
      getGoModelIds()
        .then(async (goIds) => {
          const changed = await hasGoModelsChanged(goIds);
          if (changed) {
            console.log(
              "[auto] Go model list changed, refreshing in background",
            );
            await startBackgroundRefresh(goIds, "auto");
          }
        })
        .catch(() => {});
    }
    return serveHtml(cached.value);
  }

  // Cold start: no cached data. Build synchronously with slow cadence so
  // we don't hit rate limits on the very first page load.
  try {
    console.log("[cold] no cached data, building synchronously...");
    const goIds = await getGoModelIds();
    const data = await buildData(CADENCE_MS);
    await kv.set(KV_LEADERBOARD, data);
    await kv.set(KV_GO_IDS, goIds);
    return serveHtml(data);
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

Deno.serve(handler);
export default handler;
