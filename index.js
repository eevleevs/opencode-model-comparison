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

function valueIndex(rows, slug, inT, outT, aggRanks) {
  const bench = window.BENCH.find(b => b.slug === slug);
  const invert = bench?.invert ?? false;
  const scored = [];
  for (const r of rows) {
    let b = r.benchmarks[slug];
    // For aggregated benchmark, use the client-computed aggRanks
    if (slug === "aggregated") {
      b = aggRanks?.[r.id] ?? null;
    }
    if (b == null) continue;
    if (r.costIn == null || r.costOut == null) continue;
    const cpr = (inT/1e6)*r.costIn + (outT/1e6)*r.costOut;
    if (cpr <= 0) continue;
    const score = invert ? (1 / b) : b;
    scored.push({ id: r.id, v: score / cpr });
  }
  const max = Math.max(0, ...scored.map(s => s.v));
  const m = {};
  for (const s of scored) m[s.id] = max > 0 ? (s.v/max)*100 : 0;
  return m;
}

let sortKey = "val", sortDir = -1;

function aggRankIndex() {
  const ranks = {};
  for (const b of window.BENCH) {
    if (!b.api) continue;
    const scored = [];
    for (const r of window.ROWS) {
      const score = r.benchmarks[b.slug];
      if (score == null) continue;
      scored.push({ id: r.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((s, i) => {
      const rank = i + 1;
      if (!ranks[s.id]) ranks[s.id] = { sum: 0, count: 0 };
      ranks[s.id].sum += rank;
      ranks[s.id].count++;
    });
  }
  const result = {};
  for (const id of Object.keys(ranks)) {
    if (ranks[id].count > 0) result[id] = ranks[id].sum / ranks[id].count;
  }
  return result;
}

function render() {
  const inT = +document.getElementById("inT").value || 0;
  const outT = +document.getElementById("outT").value || 0;
  const aggRanks = aggRankIndex();
  const vals = valueIndex(window.ROWS, "aggregated", inT, outT, aggRanks);

  const rows = window.ROWS.map(r => {
    const cpr = (r.costIn!=null && r.costOut!=null)
      ? (inT/1e6)*r.costIn + (outT/1e6)*r.costOut : null;
    return {
      ...r,
      _cpr: cpr,
      _val: vals[r.id] ?? null,
      _aggRank: aggRanks[r.id] ?? null,
    };
  });

  const numLike = (k) => ["rank","costPerRequest","costIn","costOut","scicode","tau2","lcr","aggRank","val"].includes(k);
  rows.sort((a,b) => {
    let av, bv;
    if (sortKey === "val") { av = a._val; bv = b._val; }
    else if (sortKey === "aggRank") { av = a._aggRank; bv = b._aggRank; }
    else if (sortKey === "scicode" || sortKey === "tau2" || sortKey === "lcr") { av = a.benchmarks[sortKey]; bv = b.benchmarks[sortKey]; }
    else if (sortKey === "costPerRequest") { av = a._cpr; bv = b._cpr; }
    else { av = a[sortKey]; bv = b[sortKey]; }
    if (av == null) av = -Infinity; if (bv == null) bv = -Infinity;
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  let rank = 0;
  for (const r of rows) {
    const hasScore = r._val != null;
    if (hasScore) rank++;
    const medal = rank <= 3 ? '<span class="medal">★</span> ' : "";
    const barW = r._val != null ? Math.max(2, r._val) : 0;
    const valCell = r._val == null
      ? '<span class="na">—</span>'
      : '<span class="val">'+r._val.toFixed(1)+'</span> <span class="bar" style="width:'+barW+'px"></span>';
    const cprCell = r._cpr == null ? '<span class="na">—</span>' : fmtUsd(r._cpr);
    const benchCell = (v) => v == null ? '<span class="na">—</span>' : fmt(v, v >= 1 ? 0 : 3);
    const aggRankCell = r._aggRank == null ? '<span class="na">—</span>' : r._aggRank.toFixed(0);
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="num rank">'+(hasScore? medal+rank : '<span class="na">–</span>')+'</td>'+
      '<td>'+escapeHtml(r.name)+' <span class="pill">'+escapeHtml(r.id)+'</span></td>'+
      '<td>'+(r.creator?escapeHtml(r.creator):'<span class="na">—</span>')+'</td>'+
      '<td>'+(r.releaseDate||'<span class="na">—</span>')+'</td>'+
      '<td class="num">'+cprCell+'</td>'+
      '<td class="num">'+(r.costIn==null?'<span class="na">—</span>':fmtUsd(r.costIn))+'</td>'+
      '<td class="num">'+(r.costOut==null?'<span class="na">—</span>':fmtUsd(r.costOut))+'</td>'+
      '<td class="num">'+benchCell(r.benchmarks.scicode)+'</td>'+
      '<td class="num">'+benchCell(r.benchmarks.tau2)+'</td>'+
      '<td class="num">'+benchCell(r.benchmarks.lcr)+'</td>'+
      '<td class="num">'+aggRankCell+'</td>'+
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
