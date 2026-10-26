// Client-side tick loop (the incremental build/refresh poller).
// deno-lint-ignore-file no-window
// The render path deliberately lives in index.html as an inline classic script,
// not here: this file is a module, so it runs only after the document has been
// parsed (and after queue.js has been fetched). Anything it rendered would
// land a frame or two after every load, and the page blinked empty in between.
// The inline script owns render()/sort state and exposes them as globals; this
// module drives the queues and calls render() to patch rows in place as ticks
// land. The tick-queue helpers live next to the tests (queue.js), imported as
// a module: the whole poll loop's bookkeeping is shared, not re-implemented.
import { advanceTick, nextTickTarget } from "./queue.js";

// --- Incremental build: tick through the todo list the page embedded in
// BUILD. The server used to recompute "what is still pending" from KV on every
// tick, but Workers KV serves reads right after a write stale for up to a
// minute — the status line kept saying "1 more model" and CloudPrice was asked
// for the same model ~10 times in a row after ?refresh=1. The client owns the
// queues instead: one unit of work per tick, popped only when the server says
// it is handled, so the count falls exactly once per real action.
const build = window.BUILD || {};
const queues = {
  creators: Array.isArray(build.pendingCreators) ? build.pendingCreators.slice() : [],
  build: Array.isArray(build.pendingBuild) ? build.pendingBuild.slice() : [],
};
// Refresh epoch echoed on every tick: a tick landing on another machine can
// read the pre-refresh KV_GO_REFRESH, which would skip the refetch it was
// asked for as "fresh".
const refreshAt = Number(build.refreshAt) || 0;
const buildStatus = document.getElementById("build-status");
let stopped = false;
let retryAfterMs = Number.isFinite(build.retryAfterMs)
  ? build.retryAfterMs
  : null;

function setBuildStatus(text) {
  if (buildStatus) buildStatus.textContent = text;
}

function scheduleTick() {
  if (stopped || !nextTickTarget(queues)) return;
  const delay = retryAfterMs
    ? Math.max(10000, retryAfterMs + 100)
    : Math.max(2500, 2500 + Math.random() * 500);
  setTimeout(doTick, delay);
}

// Row patched in place as ticks land, so the table fills without a reload.
function applyTickResult(target, r) {
  if (target.kind === "resolveCreator") {
    if (!r.id || typeof r.creator !== "string" || !r.creator) return;
    const row = window.ROWS.find((x) => x.id === r.id);
    if (row && row.creator !== r.creator) {
      row.creator = r.creator;
      render();
    }
    return;
  }
  if (r.kind !== "fetched" || !r.id || !r.value) return;
  const row = window.ROWS.find((x) => x.id === r.id);
  if (!row) return;
  for (const b of window.BENCH) {
    row.benchmarks[b.slug] = r.value[b.slug] ?? null;
    row.percentiles[b.slug] = r.percentile?.[b.slug] ?? null;
  }
  row.matched = window.BENCH.some((b) => row.benchmarks[b.slug] != null);
  render();
}

async function doTick() {
  if (stopped) return;
  const target = nextTickTarget(queues);
  if (!target) return; // queue drained between scheduleTick and now
  setBuildStatus(
    "Building leaderboard — fetching benchmark data for " +
    (queues.creators.length + queues.build.length) + " more model(s)…",
  );
  let res;
  try {
    const param = target.kind === "resolveCreator" ? "resolveCreator" : "next";
    const url = "/?tick=1&" + param + "=" + encodeURIComponent(target.id) +
      (refreshAt > 0 ? "&refreshAt=" + refreshAt : "");
    res = await fetch(url);
  } catch {
    scheduleTick();
    return;
  }
  if (!res.ok) {
    scheduleTick();
    return;
  }
  let r;
  try {
    r = await res.json();
  } catch {
    scheduleTick();
    return;
  }
  retryAfterMs = Number.isFinite(r?.retryAfterMs) ? r.retryAfterMs : null;
  const adv = advanceTick(queues, r);
  if (adv.action === "retry") {
    scheduleTick();
    return;
  }
  queues.creators = adv.queues.creators;
  queues.build = adv.queues.build;
  applyTickResult(target, r);
  if (adv.done) {
    stopped = true;
    setBuildStatus("");
    location.href = "/";
    return;
  }
  scheduleTick();
}

scheduleTick();
