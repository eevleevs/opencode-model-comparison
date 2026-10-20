// Client-side leaderboard logic
// deno-lint-ignore-file no-window
// The tick-queue helpers live next to the tests (queue.js), imported as a
// module: the whole poll loop's bookkeeping is shared, not re-implemented.
import { advanceTick, nextTickTarget } from "./queue.js";

const fmt = (n, d = 4) => n == null ? null : Number(n).toFixed(d);
const fmtNum = (n) => n == null ? null : n.toLocaleString();

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const benchSlugs = window.BENCH.map((b) => b.slug);
const isBenchKey = (k) => benchSlugs.includes(k);

// Short display labels for benchmark <th> headers. These are the source of
// truth for the UI; the `label` field in the cached BENCH JSON is ignored
// so that header text stays current even if the KV cache is stale.
const LABELS = {
  scicode: "SciCode",
  coding_index: "CodInd",
  lcr: "LCR",
  terminalbench_hard: "TermBench",
  tau2: "TAU2",
  ifbench: "IFBench",
  intelligence_index: "IntInd",
  gpqa: "GPQA",
  hle: "HLE",
};

// Aggregate ranking: average the CloudPrice percentile (0-100) across each
// model's available benchmarks. Percentile is on a common scale across mixed
// 0-1 / 0-100 benchmarks, so no manual min-max normalization is needed.
function aggBenchIndex() {
  const sums = {};
  const counts = {};
  for (const r of window.ROWS) {
    if (!r.percentiles) continue;
    let s = 0, c = 0;
    for (const slug of benchSlugs) {
      const p = r.percentiles[slug];
      if (typeof p === "number") {
        s += p;
        c++;
      }
    }
    if (c > 0) {
      sums[r.id] = s;
      counts[r.id] = c;
    }
  }
  const out = {};
  for (const id of Object.keys(sums)) out[id] = sums[id] / counts[id];
  return out;
}

// Docs publish "Unlimited" for non-metered models, so their value is unbounded:
// they sort above every metered model and render as an infinity glyph. A
// literal is fine: the em dashes already in this file rely on the same UTF-8
// path, and /index.js is served as application/javascript with no charset.
const INFINITY_GLYPH = "∞";

function valueIndex(rows, aggScores) {
  const scored = [];
  const unbounded = [];
  for (const r of rows) {
    // Checked before the percentile guard: ∞ is a statement about limits, not
    // about benchmarks, so it must show even with no benchmark data.
    if (r.unlimited) {
      unbounded.push(r.id);
      continue;
    }
    const pct = aggScores?.[r.id] ?? null;
    if (pct == null) continue;
    const rpm = r.reqPerMonth;
    if (rpm == null) continue;
    scored.push({ id: r.id, v: (pct / 100) * rpm });
  }
  const max = Math.max(0, ...scored.map((s) => s.v));
  const m = {};
  for (const s of scored) m[s.id] = max > 0 ? (s.v / max) * 100 : 0;
  for (const id of unbounded) m[id] = Infinity;
  return m;
}

let sortKey = localStorage.getItem("oc-sort-key") || "val";
let sortDir = Number(localStorage.getItem("oc-sort-dir")) || -1;

function persistSort() {
  localStorage.setItem("oc-sort-key", sortKey);
  localStorage.setItem("oc-sort-dir", String(sortDir));
}

function render() {
  const aggScores = aggBenchIndex();
  const vals = valueIndex(window.ROWS, aggScores);

  const rows = window.ROWS.map((r) => ({
    ...r,
    _val: vals[r.id] ?? null,
    _aggBench: aggScores[r.id] ?? null,
  }));

  rows.sort((a, b) => {
    let av, bv;
    if (sortKey === "val") {
      av = a._val;
      bv = b._val;
    } else if (sortKey === "aggBench") {
      av = a._aggBench;
      bv = b._aggBench;
    } else if (isBenchKey(sortKey)) {
      av = a.benchmarks[sortKey];
      bv = b.benchmarks[sortKey];
    } else if (
      sortKey === "reqPer5h" || sortKey === "reqPerWeek" ||
      sortKey === "reqPerMonth"
    ) {
      av = a[sortKey];
      bv = b[sortKey];
    } else if (sortKey === "id") {
      av = a.id;
      bv = b.id;
    } else {
      av = a[sortKey];
      bv = b[sortKey];
    }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    // Infinity - Infinity is NaN, which sort treats as "no swap" and would
    // leave the unbounded rows in arbitrary order. Tiebreak deterministically.
    if (av === Infinity && bv === Infinity) return a.id.localeCompare(b.id);
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const valCell = r._val === Infinity
      ? INFINITY_GLYPH
      : r._val == null
      ? '<span class="na">—</span>'
      : r._val.toFixed(1);
    const benchCell = (v) =>
      v == null ? '<span class="na">—</span>' : fmt(v, v >= 1 ? 0 : 3);
    const aggBenchCell = r._aggBench == null
      ? '<span class="na">—</span>'
      : r._aggBench.toFixed(1);
    // Counts are null on unlimited rows, so the dash would be misleading.
    const reqCell = (v) =>
      r.unlimited
        ? INFINITY_GLYPH
        : v == null
        ? '<span class="na">—</span>'
        : fmtNum(v);

    let html = "<td>" + escapeHtml(r.id) + "</td>" +
      "<td>" +
      (r.creator ? escapeHtml(r.creator) : '<span class="na">—</span>') +
      "</td>" +
      '<td class="num">' + reqCell(r.reqPer5h) + "</td>" +
      '<td class="num">' + reqCell(r.reqPerWeek) + "</td>" +
      '<td class="num">' + reqCell(r.reqPerMonth) + "</td>";
    for (const slug of benchSlugs) {
      html += '<td class="num">' + benchCell(r.benchmarks[slug]) + "</td>";
    }
    html += '<td class="num">' + aggBenchCell + "</td>" +
      '<td class="num">' + valCell + "</td>";
    const tr = document.createElement("tr");
    tr.innerHTML = html;
    tb.appendChild(tr);
  }
  document.querySelectorAll("th").forEach((th) => {
    th.classList.toggle("active", th.dataset.k === sortKey);
  });
}

// Inject one <th> per benchmark into the static thead, between reqPerMonth
// and AggBench, before any click handlers are attached.
(function injectBenchHeaders() {
  const benchHead = document.querySelector('th[data-k="aggBench"]');
  if (!benchHead) return;
  const tr = benchHead.parentElement;
  for (const b of window.BENCH) {
    const th = document.createElement("th");
    th.className = "num";
    th.dataset.k = b.slug;
    th.textContent = LABELS[b.slug] ?? b.slug;
    tr.insertBefore(th, benchHead);
  }
})();

document.querySelectorAll("th").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1;
    else {
      sortKey = k;
      sortDir = -1;
    }
    persistSort();
    render();
  });
});

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

render();
