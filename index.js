// Client-side leaderboard logic
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

function valueIndex(rows, aggScores) {
  const scored = [];
  for (const r of rows) {
    const b = aggScores?.[r.id] ?? null;
    if (b == null) continue;
    const rpm = r.reqPerMonth;
    if (rpm == null) continue;
    scored.push({ id: r.id, v: b * rpm });
  }
  const max = Math.max(0, ...scored.map((s) => s.v));
  const m = {};
  for (const s of scored) m[s.id] = max > 0 ? (s.v / max) * 100 : 0;
  return m;
}

let sortKey = "val", sortDir = -1;

function aggBenchIndex() {
  const scores = {};
  const counts = {};
  for (const b of window.BENCH) {
    if (!b.api) continue;
    const values = [];
    for (const r of window.ROWS) {
      const score = r.benchmarks[b.slug];
      if (score != null) values.push(score);
    }
    if (values.length === 0) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    for (const r of window.ROWS) {
      const score = r.benchmarks[b.slug];
      if (score == null) continue;
      const normalized = (score - min) / range;
      if (!scores[r.id]) scores[r.id] = 0;
      if (!counts[r.id]) counts[r.id] = 0;
      scores[r.id] += normalized;
      counts[r.id]++;
    }
  }
  const result = {};
  for (const id of Object.keys(scores)) {
    result[id] = scores[id] / counts[id];
  }
  return result;
}

function render() {
  const aggScores = aggBenchIndex();
  const vals = valueIndex(window.ROWS, aggScores);

  const rows = window.ROWS.map((r) => ({
    ...r,
    _val: vals[r.id] ?? null,
    _aggBench: aggScores[r.id] ?? null,
  }));

  const numLike = (k) =>
    [
      "reqPer5h",
      "reqPerWeek",
      "reqPerMonth",
      "scicode",
      "tau2",
      "lcr",
      "aggBench",
      "val",
    ].includes(k);
  rows.sort((a, b) => {
    let av, bv;
    if (sortKey === "val") {
      av = a._val;
      bv = b._val;
    } else if (sortKey === "aggBench") {
      av = a._aggBench;
      bv = b._aggBench;
    } else if (
      sortKey === "scicode" || sortKey === "tau2" || sortKey === "lcr"
    ) {
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
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const valCell = r._val == null
      ? '<span class="na">—</span>'
      : r._val.toFixed(1);
    const benchCell = (v) =>
      v == null ? '<span class="na">—</span>' : fmt(v, v >= 1 ? 0 : 3);
    const aggBenchCell = r._aggBench == null
      ? '<span class="na">—</span>'
      : (r._aggBench * 100).toFixed(1);
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + escapeHtml(r.id) + "</td>" +
      "<td>" +
      (r.creator ? escapeHtml(r.creator) : '<span class="na">—</span>') +
      "</td>" +
      "<td>" + (r.releaseDate || '<span class="na">—</span>') + "</td>" +
      '<td class="num">' +
      (r.reqPer5h == null ? '<span class="na">—</span>' : fmtNum(r.reqPer5h)) +
      "</td>" +
      '<td class="num">' + (r.reqPerWeek == null
        ? '<span class="na">—</span>'
        : fmtNum(r.reqPerWeek)) +
      "</td>" +
      '<td class="num">' + (r.reqPerMonth == null
        ? '<span class="na">—</span>'
        : fmtNum(r.reqPerMonth)) +
      "</td>" +
      '<td class="num">' + benchCell(r.benchmarks.scicode) + "</td>" +
      '<td class="num">' + benchCell(r.benchmarks.tau2) + "</td>" +
      '<td class="num">' + benchCell(r.benchmarks.lcr) + "</td>" +
      '<td class="num">' + aggBenchCell + "</td>" +
      '<td class="num">' + valCell + "</td>";
    tb.appendChild(tr);
  }
  document.querySelectorAll("th").forEach((th) => {
    th.classList.toggle("active", th.dataset.k === sortKey);
  });
}

document.querySelectorAll("th").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1;
    else {
      sortKey = k;
      sortDir = -1;
    }
    render();
  });
});

render();
