// OpenCode Go Model Leaderboard
// Fetches the latest models available on OpenCode Go, their utilization limits
// (from the Go docs), and coding benchmarks (from CloudPrice), then ranks them
// by a "value" score = benchmark performance × requests per month.
//
// Deploy: `deno run --allow-net --allow-read --unstable-kv main.ts`

const OC_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const GO_DOCS_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx";
const CLOUDPRICE = "https://ai.cloudprice.net/api/v1";

// Benchmarks we pull from CloudPrice. `coding: true` marks the ones that are
// coding/agentic focused and surfaced first in the ranking selector.
const BENCHMARKS = [
  { slug: "scicode", label: "SciCode", coding: true, api: true },
  { slug: "tau2", label: "TAU2 (agentic)", coding: true, api: true },
  { slug: "lcr", label: "LCR (long-context)", coding: true, api: true },
];

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REQ_TIMEOUT_MS = 20000;

// CloudPrice rate-limits aggressively, so retry 429s with backoff. A hard
// request timeout keeps a single slow/failed call from wedging the whole build.
async function fetchJson(url: string, attempts = 4): Promise<any> {
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
        // Cap retry-after at 10s — waiting 60s per request is unacceptable.
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10000)
          : 2000 * 2 ** i;
        console.log(
          `[fetch] 429 rate limited on ${url}, retrying in ${delay}ms (attempt ${
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
      // Aborted (timed out) -> don't keep hammering, surface the error.
      if (e instanceof DOMException && e.name === "AbortError") break;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr ?? new Error(`GET ${url} failed`);
}

// Parse Markdown tables from MDX source
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

type GoLimits = {
  limits: Record<
    string,
    { reqPer5h: number; reqPerWeek: number; reqPerMonth: number }
  >;
  fetchedAt: number;
};

const GO_LIMITS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  const mdx = await fetchJson(GO_DOCS_URL);
  const tables = parseMarkdownTables(mdx);

  const endpointsTable = findTable(tables, "Model ID");
  const requestsTable = findTable(tables, "requests per 5 hour");

  if (!endpointsTable || !requestsTable) {
    throw new Error("Failed to parse Go docs tables");
  }

  // Build displayName -> id map from Endpoints table
  const displayNameToId = new Map<string, string>();
  for (const row of endpointsTable.rows) {
    const displayName = row[0];
    const modelId = row[1];
    if (displayName && modelId) {
      displayNameToId.set(displayName, modelId);
    }
  }

  // Build limits map keyed by model id
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

// Deno KV for persistent caching
const kv = await Deno.openKv();
const KV_KEY = ["leaderboard", "data"];

type BuildResult = Awaited<ReturnType<typeof buildData>>;

async function getBuildData(forceRefresh = false): Promise<BuildResult> {
  if (forceRefresh) {
    // Explicitly delete old cache before fetching fresh data
    await kv.delete(KV_KEY);
  } else {
    const entry = await kv.get<BuildResult>(KV_KEY);
    if (entry.value) return entry.value;
  }

  const data = await buildData();
  await kv.set(KV_KEY, data);
  return data;
}

// Pull one benchmark leaderboard, paginating through every entry.
async function fetchLeaderboard(
  slug: string,
): Promise<{ values: Map<string, number>; creators: Map<string, string> }> {
  const values = new Map<string, number>();
  const creators = new Map<string, string>();
  let token: string | undefined;
  let guard = 0;
  do {
    const url = new URL(`${CLOUDPRICE}/benchmarks/${slug}/leaderboard`);
    url.searchParams.set("page_size", "100");
    if (token) url.searchParams.set("next_token", token);
    const d = await fetchJson(url.toString());
    const rows: any[] = d.data ?? [];
    for (const r of rows) {
      if (typeof r.value === "number") values.set(r.model_id, r.value);
      if (r.creator) creators.set(r.model_id, r.creator);
    }
    token = d.pagination?.has_next ? d.pagination.next_token : undefined;
  } while (token && guard++ < 100);
  return { values, creators };
}

type Row = {
  id: string;
  name: string;
  creator: string;
  releaseDate: string | null;
  reqPer5h: number | null;
  reqPerWeek: number | null;
  reqPerMonth: number | null;
  benchmarks: Record<string, number | null>;
  matched: boolean;
};

async function buildData(): Promise<{
  rows: Row[];
  benchmarks: typeof BENCHMARKS;
  updatedAt: string;
  notes: string[];
}> {
  const notes: string[] = [];

  // 1) Live list of models on OpenCode Go (authoritative, current).
  const ocRes = await fetchJson(OC_GO_MODELS_URL);
  const ocIds: string[] = ocRes.data.map((m: any) => m.id);

  // 2) Go utilization limits from docs (KV-cached, 7-day TTL).
  let goLimits: Record<
    string,
    { reqPer5h: number; reqPerWeek: number; reqPerMonth: number }
  > = {};
  try {
    goLimits = await fetchGoLimits();
  } catch (e) {
    notes.push(`Go limits fetch failed: ${(e as Error).message}`);
  }

  // 3) Benchmarks from CloudPrice.
  const benchMaps: Record<string, Map<string, number>> = {};
  const creatorMaps: Record<string, Map<string, string>> = {};
  for (const b of BENCHMARKS) {
    if (!b.api) continue;
    console.log(`[build] fetching ${b.slug}...`);
    try {
      const result = await fetchLeaderboard(b.slug);
      benchMaps[b.slug] = result.values;
      creatorMaps[b.slug] = result.creators;
      console.log(`[build] ${b.slug}: ${result.values.size} entries`);
    } catch (e) {
      benchMaps[b.slug] = new Map();
      creatorMaps[b.slug] = new Map();
      notes.push(`Benchmark ${b.slug} unavailable: ${(e as Error).message}`);
    }
  }

  const rows: Row[] = [];
  let matchedCount = 0;
  let withBenchmarks = 0;

  for (const id of ocIds) {
    const limits = goLimits[id] ?? null;

    // Match each benchmark independently (different benchmarks may use different ID formats).
    const benchmarks: Record<string, number | null> = {};
    let matchedAny = false;
    let creator = "";
    for (const b of BENCHMARKS) {
      if (!b.api) {
        benchmarks[b.slug] = null;
        continue;
      }
      let benchValue: number | null = null;
      for (const key of benchMaps[b.slug].keys()) {
        if (
          norm(key) === norm(id) || norm(key).endsWith(norm(id)) ||
          norm(id).endsWith(norm(key))
        ) {
          benchValue = benchMaps[b.slug].get(key) ?? null;
          if (!creator) creator = creatorMaps[b.slug].get(key) ?? "";
          break;
        }
      }
      benchmarks[b.slug] = benchValue;
      if (benchValue != null) matchedAny = true;
    }
    // Fallback: extract creator from model ID (e.g., "minimax-m3" -> "minimax")
    if (!creator) {
      const parts = id.split(/[-.]/);
      if (parts.length > 1) creator = parts[0];
    }
    if (matchedAny) {
      matchedCount++;
      withBenchmarks++;
    }

    rows.push({
      id,
      name: id,
      creator,
      releaseDate: null,
      reqPer5h: limits?.reqPer5h ?? null,
      reqPerWeek: limits?.reqPerWeek ?? null,
      reqPerMonth: limits?.reqPerMonth ?? null,
      benchmarks,
      matched: matchedAny,
    });
  }

  console.log(
    `[build] matched ${matchedCount}/${ocIds.length} models to CloudPrice, ${withBenchmarks} have at least one benchmark`,
  );
  for (const b of BENCHMARKS) {
    if (!b.api) continue;
    const count = rows.filter((r) => r.benchmarks[b.slug] != null).length;
    console.log(`[build] ${b.slug}: ${count} models with data`);
  }
  const unmatched = rows.filter((r) => !r.matched).length;
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

function valueIndex(rows: Row[], slug: string): Map<string, number> {
  const scored: { id: string; v: number }[] = [];
  for (const r of rows) {
    const b = r.benchmarks[slug];
    if (b == null) continue;
    const rpm = r.reqPerMonth;
    if (rpm == null) continue;
    scored.push({ id: r.id, v: b * rpm });
  }
  const max = Math.max(...scored.map((s) => s.v), 0);
  const map = new Map<string, number>();
  for (const s of scored) map.set(s.id, max > 0 ? (s.v / max) * 100 : 0);
  return map;
}

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

function renderHtml(data: {
  rows: Row[];
  benchmarks: typeof BENCHMARKS;
  updatedAt: string;
  notes: string[];
}): string {
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

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Serve static files
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
  // Browsers auto-request /favicon.ico; don't waste a full build on it.
  if (url.pathname !== "/") {
    return new Response("Not Found", { status: 404 });
  }
  try {
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const data = await getBuildData(forceRefresh);
    const html = renderHtml(data);
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
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

// Runs both locally (`deno run --allow-net main.ts`) and on Deno Deploy.
Deno.serve(handler);

export default handler;
