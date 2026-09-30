// Client-side leaderboard logic
// deno-lint-ignore-file no-window
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

// --- Incremental build: tick-poll until the leaderboard is fully populated.
// The server fetches at most one CloudPrice model per /?tick=1 request, so the
// client simply polls until remaining hits 0, waiting out 429 retry-after.
const build = window.BUILD || { remaining: 0, retryAfterMs: null };
const buildStatus = document.getElementById("build-status");
let stopped = false;

function setBuildStatus(text) {
  if (buildStatus) buildStatus.textContent = text;
}

function scheduleTick() {
  if (stopped || build.remaining <= 0) return;
  const delay = build.retryAfterMs
    ? Math.max(10000, build.retryAfterMs + 100)
    : Math.max(2500, 2500 + Math.random() * 500);
  setTimeout(doTick, delay);
}

async function doTick() {
  if (stopped || build.remaining <= 0) return;
  setBuildStatus(
    "Building leaderboard — fetching benchmark data for " + build.remaining +
    " more model(s)…",
  );
  let res;
  try {
    res = await fetch("/?tick=1");
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
  build.remaining = Number.isInteger(r.remaining) ? r.remaining : build.remaining - 1;
  build.retryAfterMs = Number.isFinite(r.retryAfterMs) ? r.retryAfterMs : null;
  if (r.fetched && r.id && r.value) {
    const row = window.ROWS.find((x) => x.id === r.id);
    if (row) {
      for (const b of window.BENCH) {
        row.benchmarks[b.slug] = r.value[b.slug] ?? null;
        row.percentiles[b.slug] = r.percentile?.[b.slug] ?? null;
      }
      row.matched = window.BENCH.some((b) => row.benchmarks[b.slug] != null);
      render();
    }
  }
  if (build.remaining <= 0) {
    stopped = true;
    setBuildStatus("");
    location.href = "/";
    return;
  }
  scheduleTick();
}

scheduleTick();

render();
