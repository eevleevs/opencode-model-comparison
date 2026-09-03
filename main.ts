// OpenCode Go Model Leaderboard
// Fetches the latest models available on OpenCode Go, their per-token cost
// (from models.dev), and coding benchmarks (from CloudPrice), then ranks them
// by a "value" score = benchmark performance / cost per request.
//
// Deploy: `deno run --allow-net main.ts` (or push to Deno Deploy).

const OC_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const MODELSDEV_URL = "https://models.dev/api.json";
const CLOUDPRICE = "https://ai.cloudprice.net/api/v1";

// Benchmarks we pull from CloudPrice. `coding: true` marks the ones that are
// coding/agentic focused and surfaced first in the ranking selector.
const BENCHMARKS = [
  { slug: "scicode", label: "SciCode", coding: true, api: true },
  { slug: "tau2", label: "TAU2 (agentic)", coding: true, api: true },
  { slug: "lcr", label: "LCR (long-context)", coding: true, api: true },
];

const DEFAULT_IN_TOKENS = 6000;
const DEFAULT_OUT_TOKENS = 2000;

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
        console.log(`[fetch] 429 rate limited on ${url}, retrying in ${delay}ms (attempt ${i + 1}/${attempts})`);
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

async function fetchModelsDev(): Promise<any> {
  return fetchJson(MODELSDEV_URL);
}

// Pull one benchmark leaderboard, paginating through every entry.
async function fetchLeaderboard(slug: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let token: string | undefined;
  let guard = 0;
  do {
    const url = new URL(`${CLOUDPRICE}/benchmarks/${slug}/leaderboard`);
    url.searchParams.set("page_size", "100");
    if (token) url.searchParams.set("next_token", token);
    const d = await fetchJson(url.toString());
    const rows: any[] = d.data ?? [];
    for (const r of rows) {
      if (typeof r.value === "number") out.set(r.model_id, r.value);
    }
    token = d.pagination?.has_next ? d.pagination.next_token : undefined;
  } while (token && guard++ < 100);
  return out;
}

type Row = {
  id: string;
  name: string;
  creator: string;
  releaseDate: string | null;
  costIn: number | null;
  costOut: number | null;
  costPerRequest: number | null;
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

  // 2) models.dev -> opencode-go provider gives cost + display name + release.
  const md = await fetchModelsDev();
  const ocProvider = md["opencode-go"] ?? {};
  const ocModels: Record<string, any> = ocProvider.models ?? {};
  if (!ocModels || Object.keys(ocModels).length === 0) {
    notes.push("models.dev opencode-go provider unavailable; cost shown as N/A.");
  }

  // 3) Benchmarks only — skip the full CloudPrice catalog to save requests.
  // Rate limit: 20 requests/minute. We need ~12 total (3 benchmarks × ~4 pages), so minimal delays.
  const benchMaps: Record<string, Map<string, number>> = {};
  for (const b of BENCHMARKS) {
    if (!b.api) continue;
    console.log(`[build] fetching ${b.slug}...`);
    try {
      benchMaps[b.slug] = await fetchLeaderboard(b.slug);
      console.log(`[build] ${b.slug}: ${benchMaps[b.slug].size} entries`);
    } catch (e) {
      benchMaps[b.slug] = new Map();
      notes.push(`Benchmark ${b.slug} unavailable: ${(e as Error).message}`);
    }
  }

  const rows: Row[] = [];
  let matchedCount = 0;
  let withBenchmarks = 0;

  for (const id of ocIds) {
    const mdModel = ocModels[id];
    const name = mdModel?.name ?? id;
    const costIn = mdModel?.cost?.input ?? null;
    const costOut = mdModel?.cost?.output ?? null;

    // Match each benchmark independently (different benchmarks may use different ID formats).
    const benchmarks: Record<string, number | null> = {};
    let matchedAny = false;
    for (const b of BENCHMARKS) {
      if (!b.api) {
        benchmarks[b.slug] = null;
        continue;
      }
      let benchValue: number | null = null;
      for (const key of benchMaps[b.slug].keys()) {
        if (norm(key) === norm(id) || norm(key).endsWith(norm(id)) || norm(id).endsWith(norm(key))) {
          benchValue = benchMaps[b.slug].get(key) ?? null;
          break;
        }
      }
      benchmarks[b.slug] = benchValue;
      if (benchValue != null) matchedAny = true;
    }
    // Extract creator from model ID (e.g., "minimax-m3" -> "minimax")
    let creator = "";
    const parts = id.split(/[-.]/);
    if (parts.length > 1) creator = parts[0];
    if (matchedAny) {
      matchedCount++;
      withBenchmarks++;
    }

    const costPerRequest = costIn !== null && costOut !== null
      ? (DEFAULT_IN_TOKENS / 1e6) * costIn + (DEFAULT_OUT_TOKENS / 1e6) * costOut
      : null;

    let releaseDate: string | null = mdModel?.release_date ?? null;

    rows.push({
      id,
      name,
      creator,
      releaseDate,
      costIn,
      costOut,
      costPerRequest,
      benchmarks,
      matched: matchedAny,
    });
  }

  console.log(`[build] matched ${matchedCount}/${ocIds.length} models to CloudPrice, ${withBenchmarks} have at least one benchmark`);
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

function valueIndex(rows: Row[], slug: string, inT: number, outT: number): Map<string, number> {
  const scored: { id: string; v: number }[] = [];
  for (const r of rows) {
    const b = r.benchmarks[slug];
    if (b == null) continue;
    const cIn = r.costIn, cOut = r.costOut;
    const cpr = cIn !== null && cOut !== null
      ? (inT / 1e6) * cIn + (outT / 1e6) * cOut
      : null;
    if (cpr == null || cpr <= 0) continue;
    scored.push({ id: r.id, v: b / cpr });
  }
  const max = Math.max(...scored.map((s) => s.v), 0);
  const map = new Map<string, number>();
  for (const s of scored) map.set(s.id, max > 0 ? (s.v / max) * 100 : 0);
  return map;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const htmlTemplate = await Deno.readTextFile(new URL("./index.html", import.meta.url));

function renderHtml(data: {
  rows: Row[];
  benchmarks: typeof BENCHMARKS;
  updatedAt: string;
  notes: string[];
}): string {
  const { rows, benchmarks, updatedAt, notes } = data;
  const codingOpts = benchmarks
    .map((b) => `<option value="${b.slug}">${escapeHtml(b.label)}${b.coding ? " (coding)" : ""}</option>`)
    .join("");
  const rowJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  const benchJson = JSON.stringify(benchmarks).replace(/</g, "\\u003c");

  const noteHtml = notes.length
    ? `<ul class="notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
    : "";

  return htmlTemplate!
    .replace("{{updatedAt}}", escapeHtml(updatedAt))
    .replace("{{codingOpts}}", codingOpts)
    .replace(/{{defaultInT}}/g, String(DEFAULT_IN_TOKENS))
    .replace(/{{defaultOutT}}/g, String(DEFAULT_OUT_TOKENS))
    .replace("{{noteHtml}}", noteHtml)
    .replace("{{rowJson}}", rowJson)
    .replace("{{benchJson}}", benchJson);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Serve static files
  if (url.pathname === "/index.js") {
    const js = await Deno.readTextFile(new URL("./index.js", import.meta.url));
    return new Response(js, {
      headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }
  if (url.pathname === "/index.css") {
    const css = await Deno.readTextFile(new URL("./index.css", import.meta.url));
    return new Response(css, {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" },
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
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  } catch (e) {
    const msg = (e as Error).message;
    return new Response(`<pre>Error building leaderboard:\n${escapeHtml(msg)}</pre>`, {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

// Runs both locally (`deno run --allow-net main.ts`) and on Deno Deploy.
Deno.serve(handler);

export default handler;
