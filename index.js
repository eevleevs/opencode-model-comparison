// Client-side leaderboard logic
const fmt = (n, d=4) => n==null ? null : Number(n).toFixed(d);
const fmtUsd = (n) => n==null ? null : "$" + (n<0.01 ? n.toFixed(5) : n.toFixed(4));

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function valueIndex(rows, slug, inT, outT, aggScores) {
  const scored = [];
  for (const r of rows) {
    let b = r.benchmarks[slug];
    // For aggregated benchmark, use the client-computed normalized scores
    if (slug === "aggregated") {
      b = aggScores?.[r.id] ?? null;
    }
    if (b == null) continue;
    if (r.costIn == null || r.costOut == null) continue;
    const cpr = (inT/1e6)*r.costIn + (outT/1e6)*r.costOut;
    if (cpr <= 0) continue;
    scored.push({ id: r.id, v: b / cpr });
  }
  const max = Math.max(0, ...scored.map(s => s.v));
  const m = {};
  for (const s of scored) m[s.id] = max > 0 ? (s.v/max)*100 : 0;
  return m;
}

let sortKey = "val", sortDir = -1;

function aggScoreIndex() {
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
  const inT = +document.getElementById("inT").value || 0;
  const outT = +document.getElementById("outT").value || 0;
  const aggScores = aggScoreIndex();
  const vals = valueIndex(window.ROWS, "aggregated", inT, outT, aggScores);

  const rows = window.ROWS.map(r => {
    const cpr = (r.costIn!=null && r.costOut!=null)
      ? (inT/1e6)*r.costIn + (outT/1e6)*r.costOut : null;
    return {
      ...r,
      _cpr: cpr,
      _val: vals[r.id] ?? null,
      _aggScore: aggScores[r.id] ?? null,
    };
  });

  const numLike = (k) => ["costPerRequest","costIn","costOut","scicode","tau2","lcr","aggScore","val"].includes(k);
  rows.sort((a,b) => {
    let av, bv;
    if (sortKey === "val") { av = a._val; bv = b._val; }
    else if (sortKey === "aggScore") { av = a._aggScore; bv = b._aggScore; }
    else if (sortKey === "scicode" || sortKey === "tau2" || sortKey === "lcr") { av = a.benchmarks[sortKey]; bv = b.benchmarks[sortKey]; }
    else if (sortKey === "costPerRequest") { av = a._cpr; bv = b._cpr; }
    else { av = a[sortKey]; bv = b[sortKey]; }
    if (av == null) av = -Infinity; if (bv == null) bv = -Infinity;
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const valCell = r._val == null
      ? '<span class="na">—</span>'
      : r._val.toFixed(1);
    const cprCell = r._cpr == null ? '<span class="na">—</span>' : fmtUsd(r._cpr);
    const benchCell = (v) => v == null ? '<span class="na">—</span>' : fmt(v, v >= 1 ? 0 : 3);
    const aggScoreCell = r._aggScore == null ? '<span class="na">—</span>' : (r._aggScore * 100).toFixed(1);
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td>'+escapeHtml(r.name)+' <span class="pill">'+escapeHtml(r.id)+'</span></td>'+
      '<td>'+(r.creator?escapeHtml(r.creator):'<span class="na">—</span>')+'</td>'+
      '<td>'+(r.releaseDate||'<span class="na">—</span>')+'</td>'+
      '<td class="num">'+cprCell+'</td>'+
      '<td class="num">'+(r.costIn==null?'<span class="na">—</span>':fmtUsd(r.costIn))+'</td>'+
      '<td class="num">'+(r.costOut==null?'<span class="na">—</span>':fmtUsd(r.costOut))+'</td>'+
      '<td class="num">'+benchCell(r.benchmarks.scicode)+'</td>'+
      '<td class="num">'+benchCell(r.benchmarks.tau2)+'</td>'+
      '<td class="num">'+benchCell(r.benchmarks.lcr)+'</td>'+
      '<td class="num">'+aggScoreCell+'</td>'+
      '<td class="num">'+valCell+'</td>';
    tb.appendChild(tr);
  }
  document.querySelectorAll("th").forEach(th => {
    th.classList.toggle("active", th.dataset.k === sortKey);
  });
}

function savePrefs() {
  localStorage.setItem("lb-prefs", JSON.stringify({
    inT: +document.getElementById("inT").value,
    outT: +document.getElementById("outT").value,
  }));
}

// Initialize from saved preferences
const saved = JSON.parse(localStorage.getItem("lb-prefs") || "{}");
document.getElementById("inT").value = saved.inT ?? window.DEFAULT_IN_TOKENS;
document.getElementById("outT").value = saved.outT ?? window.DEFAULT_OUT_TOKENS;

document.querySelectorAll("th").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
    render();
  });
});
document.getElementById("apply").addEventListener("click", () => { savePrefs(); render(); });

render();
