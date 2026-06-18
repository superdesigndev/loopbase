// Self-contained single-page UI for `lb serve`. No build step, no framework —
// one HTML string + vanilla JS that talks to /api/*. Dark, getdesign.md-style
// hierarchy: GeistPixel-line for the hero header ONLY, Geist Mono for small
// labels/ids/numbers, Geist (sans) for body. Fonts embedded via fonts.ts.
// (docs/cost-plan.md → Phase 6.)

import { FONT_FACE_CSS } from "./fonts.ts";

export const INDEX_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>loopbase · cost</title>
<style>
${FONT_FACE_CSS}
  :root {
    --bg:#0a0a0b; --panel:#111114; --line:#222226; --line2:#2c2c32;
    --fg:#ededee; --dim:#8a8a92; --dim2:#5f5f67;
    --acc:#ff4d97; --acc2:#ff7ab3; --good:#39d98a; --warn:#e0a13a;
    --sans:"Geist",ui-sans-serif,system-ui,sans-serif;
    --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    --pixel:"GeistPixel-line","Geist Mono",monospace;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }
  ::selection { background:var(--acc); color:#0a0a0b; }
  a { color:inherit; }

  /* hero */
  header { padding:30px 32px 22px; border-bottom:1px solid var(--line); }
  .hero { font-family:var(--pixel); font-weight:400; word-spacing:-0.22em; font-size:42px; line-height:1.04; margin:0; letter-spacing:-0.01em; }
  .hero .pink { color:var(--acc); }
  .tagline { margin:10px 0 0; color:var(--dim); font-size:14px; max-width:620px; }
  .statbar { display:flex; gap:30px; margin-top:22px; flex-wrap:wrap; align-items:flex-end; }
  .stat .k { font:11px/1 var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--dim2); }
  .stat .v { font:18px/1.2 var(--mono); margin-top:7px; }
  .stat .v.big { color:var(--acc); }
  .controls { margin-left:auto; display:flex; gap:8px; align-items:center; }
  select {
    font:12px/1 var(--mono); letter-spacing:.06em; color:var(--fg); background:var(--panel);
    border:1px solid var(--line2); border-radius:7px; padding:8px 10px; cursor:pointer;
  }
  select:hover { border-color:var(--dim2); }

  /* layout */
  main { display:flex; height:calc(100vh - 165px); }
  .list { flex:1; overflow:auto; }
  .lhead { display:flex; align-items:baseline; gap:10px; padding:18px 32px 10px; }
  .lhead h2 { font:13px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--dim); margin:0; }
  .lhead .n { color:var(--dim2); font:12px/1 var(--mono); }

  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  thead th {
    position:sticky; top:0; z-index:2; background:var(--bg); text-align:left; cursor:pointer; user-select:none;
    font:11px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--dim2);
    padding:10px 16px; border-bottom:1px solid var(--line); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  thead th .rsz { position:absolute; top:0; right:0; width:7px; height:100%; cursor:col-resize; }
  thead th .rsz:hover, thead th .rsz.drag { background:var(--acc); opacity:.6; }
  td { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  thead th:first-child { padding-left:32px; }
  thead th:hover { color:var(--acc); }
  th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody td { padding:11px 16px; border-bottom:1px solid var(--line); vertical-align:baseline; }
  tbody td:first-child { padding-left:32px; }
  tr.row { cursor:pointer; }
  tr.row:hover td { background:#101013; }
  tr.sel td { background:#15151a; }
  tr.sel td:first-child { box-shadow:inset 3px 0 0 var(--acc); }

  .cost { font:13px/1 var(--mono); color:var(--fg); }
  .cost.has { color:var(--acc); }
  .cost.zero { color:var(--dim2); }
  .agent { font:11px/1 var(--mono); letter-spacing:.05em; color:var(--dim); }
  .tok { font:12px/1 var(--mono); color:var(--dim); }
  .seen { font:12px/1 var(--mono); color:var(--dim2); }
  .title { color:var(--dim); }
  .estdot { color:var(--warn); }
  .proj { font:12px/1.3 var(--mono); color:var(--fg); display:flex; align-items:center; gap:7px; max-width:100%; }
  .proj .pname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .branch { font:10px/1 var(--mono); color:var(--acc2); border:1px solid var(--line2); border-radius:4px; padding:2px 5px; white-space:nowrap; flex:none; }
  tr.grp td { background:#0e0e11; border-bottom:1px solid var(--line2); padding:12px 16px 12px 32px; cursor:pointer; }
  .grp .gname { font:12px/1 var(--mono); color:var(--fg); letter-spacing:.02em; }
  .grp .gmeta { color:var(--dim2); font:11px/1 var(--mono); margin-left:10px; }
  .grp .gcost { float:right; font:12px/1 var(--mono); color:var(--acc); }
  .grp .gcar { color:var(--dim2); display:inline-block; width:12px; }

  /* detail */
  .detail { width:0; overflow:auto; border-left:1px solid var(--line); background:var(--panel); transition:width .14s ease; }
  .detail.open { width:42%; min-width:380px; padding:26px 28px; }
  .detail .dh { font:12px/1 var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--dim2); margin-bottom:12px; }
  .detail h2 { font:18px/1.35 var(--sans); font-weight:500; margin:0 0 6px; color:var(--fg); }
  .sub { font:12px/1.5 var(--mono); color:var(--dim); margin-bottom:20px; }
  .sub .cost { font-size:12px; }
  .card { border:1px solid var(--line2); border-radius:10px; background:#141418; padding:14px 15px; margin-bottom:12px; }
  .card .top { display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .card .model { font:12px/1 var(--mono); letter-spacing:.04em; color:var(--fg); }
  .card .tk { font:11px/1.5 var(--mono); color:var(--dim2); margin-top:9px; }
  .tag { font:9px/1 var(--mono); letter-spacing:.08em; padding:3px 5px; border-radius:4px; border:1px solid var(--warn); color:var(--warn); }
  .spark { display:flex; align-items:flex-end; gap:2px; height:30px; margin-top:11px; }
  .spark i { flex:1; min-width:2px; background:linear-gradient(var(--acc),var(--acc2)); border-radius:1px 1px 0 0; opacity:.85; }
  .wl { margin-top:18px; }
  .wl .dh { margin-bottom:10px; }
  .wl .e { padding:9px 0; border-bottom:1px solid var(--line); }
  .wl .e b { font-weight:500; color:var(--fg); }
  .wl .e small { display:block; color:var(--dim2); margin-top:2px; }
  .batch { padding:9px 0; border-bottom:1px solid var(--line); }
  .batch .brow { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
  .batch b { font-weight:500; color:var(--fg); }
  .batch .cost { flex:none; }
  .batch small { display:block; color:var(--dim2); margin-top:2px; }
  .btn { font:11px/1 var(--mono); color:var(--fg); background:#15151a; border:1px solid var(--line2); border-radius:6px; padding:7px 11px; cursor:pointer; margin-top:6px; }
  .btn:hover { border-color:var(--acc); color:var(--acc); }
  .msg { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--line); }
  .msg .who { flex:none; width:64px; font:10px/1.6 var(--mono); text-transform:uppercase; letter-spacing:.06em; color:var(--dim2); }
  .msg.assistant .who { color:var(--acc2); }
  .msg .mtext { flex:1; white-space:pre-wrap; word-break:break-word; color:var(--fg); font-size:13px; }
  .msg .tools { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; }
  .tchip { font:10px/1.4 var(--mono); color:var(--dim); border:1px solid var(--line2); border-radius:4px; padding:1px 5px; }

  .empty { padding:70px; text-align:center; color:var(--dim2); font:13px/1.6 var(--mono); }
  footer { display:flex; gap:14px; align-items:center; padding:9px 32px; border-top:1px solid var(--line); color:var(--dim2); font:11px/1 var(--mono); letter-spacing:.05em; }
  footer .blip { width:7px; height:7px; border-radius:50%; background:var(--good); }
  .tabs { display:flex; gap:6px; margin:10px 0 0; }
  .tab { background:transparent; border:1px solid var(--line2); color:var(--dim2); padding:4px 14px; border-radius:7px; cursor:pointer; font-size:13px; font-family:inherit; }
  .tab.on { background:var(--line2); color:var(--fg); }
  .tab:hover { color:var(--fg); }
  #insightsView { padding:0 22px 40px; }
  .ins-note { color:var(--dim2); font-size:13px; margin:4px 0 18px; }
  .ins-groups { display:flex; flex-direction:column; gap:26px; }
  .ins-g h3 { margin:0 0 8px; font-size:14px; }
  .ins-g h3 .n { color:var(--dim2); font-weight:400; margin-left:6px; }
  .ins-row { display:grid; grid-template-columns:60px 70px 56px 1fr; gap:10px; padding:5px 0; border-top:1px solid var(--line); align-items:baseline; }
  .ins-row .num { text-align:right; font-variant-numeric:tabular-nums; color:var(--dim2); font-size:12px; }
  .ins-row .key { font-family:var(--mono); font-size:12.5px; color:var(--fg); word-break:break-word; }
  .ins-row .key .sample { color:var(--dim2); font-style:italic; }
  .ins-row .ex { display:block; margin-top:3px; color:var(--dim); font-size:11px; font-family:var(--mono); }
  ::-webkit-scrollbar { width:11px; height:11px; }
  ::-webkit-scrollbar-thumb { background:var(--line2); border:3px solid var(--bg); border-radius:6px; }
  ::-webkit-scrollbar-thumb:hover { background:var(--dim2); }
</style>
</head>
<body>
<header>
  <h1 class="hero">loopbase <span class="pink" id="heroMode">cost</span></h1>
  <nav class="tabs"><button class="tab on" id="tabCost">Cost</button><button class="tab" id="tabInsights">Insights</button></nav>
  <p class="tagline" id="tagline">Token + USD spend across every local agent session — Claude, Codex, pi. List-price estimate.</p>
  <div class="statbar">
    <div class="stat"><div class="k">Total spend</div><div class="v big" id="total">…</div></div>
    <div class="stat"><div class="k">Sessions</div><div class="v" id="count">…</div></div>
    <div class="controls">
      <select id="agent"><option value="">All agents</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">pi</option></select>
      <select id="since"><option value="">All time</option><option value="24h">24h</option><option value="7d">7d</option><option value="30d">30d</option></select>
      <select id="group"><option value="">No grouping</option><option value="project">Group by dir</option></select>
    </div>
  </div>
</header>
<main id="costView">
  <div class="list">
    <div class="lhead"><h2>Sessions by cost</h2><span class="n" id="lcount"></span></div>
    <table id="tbl">
      <colgroup>
        <col style="width:92px" /><col style="width:78px" /><col style="width:150px" />
        <col style="width:92px" /><col style="width:64px" /><col />
      </colgroup>
      <thead><tr>
        <th class="num" data-sort="total_usd">Cost</th>
        <th data-sort="agent">Agent</th>
        <th data-sort="project">Project</th>
        <th class="num" data-sort="total_tokens">Tokens</th>
        <th class="num" data-sort="last_ts">Seen</th>
        <th data-sort="title">Title</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty" class="empty" hidden>No sessions indexed yet</div>
  </div>
  <aside class="detail" id="detail"></aside>
</main>
<section id="insightsView" hidden>
  <div class="ins-note">Automation <b>candidates</b> — repeated/expensive tool patterns, call sequences, and errors. The "script-it" call is yours.</div>
  <div id="insGroups" class="ins-groups"></div>
</section>
<footer>
  <span class="blip"></span><span id="status">ready</span>
  <span style="margin-left:auto">loopbase · cost memoized at index</span>
</footer>
<script>
const $ = (s) => document.querySelector(s);
let data = [], sortKey = "total_usd", sortDir = -1;

const fmtUsd = (v) => v == null ? "—" : v >= 100 ? "$" + v.toFixed(0) : v >= 1 ? "$" + v.toFixed(2) : "$" + v.toFixed(4);
const fmtTok = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"k" : ""+(n||0);
const ago = (ts) => { if(!ts) return "?"; const s=(Date.now()-ts)/1000; if(s<3600)return Math.floor(s/60)+"m"; if(s<86400)return Math.floor(s/3600)+"h"; return Math.floor(s/86400)+"d"; };

async function load() {
  $("#status").textContent = "indexing…";
  const agent = $("#agent").value, since = $("#since").value;
  const qs = new URLSearchParams({ all: "true", limit: "500" });
  if (agent) qs.set("agent", agent);
  if (since) qs.set("since", since);
  const j = await (await fetch("/api/sessions?" + qs)).json();
  data = j.sessions || [];
  $("#total").textContent = fmtUsd(j.total_usd);
  $("#count").textContent = data.length;
  $("#lcount").textContent = data.length + " shown";
  $("#status").textContent = data.length + " sessions";
  render();
}

function sortData() {
  data.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (sortKey === "total_usd" || sortKey === "total_tokens" || sortKey === "last_ts") { x = x ?? -1; y = y ?? -1; return (x - y) * sortDir; }
    return String(x ?? "").localeCompare(String(y ?? "")) * sortDir;
  });
}

const base = (p) => { if (!p) return "(no project)"; const x = p.replace(/\\/+$/, "").split("/"); return x[x.length - 1] || p; };

function rowCells(s) {
  const cc = "cost " + (s.total_usd == null ? "zero" : "has");
  const branch = s.branch ? '<span class="branch">' + escapeHtml(s.branch) + '</span>' : "";
  return (
    '<td class="num"><span class="' + cc + '">' + fmtUsd(s.total_usd) + '</span>' + (s.estimated ? ' <span class="estdot">~</span>' : '') + '</td>' +
    '<td><span class="agent">' + s.agent + '</span></td>' +
    '<td><div class="proj" title="' + escapeHtml(s.cwd || s.project || "") + '"><span class="pname">' + escapeHtml(base(s.project)) + '</span>' + branch + '</div></td>' +
    '<td class="num tok">' + fmtTok(s.total_tokens) + '</td>' +
    '<td class="num seen">' + ago(s.last_ts) + '</td>' +
    '<td class="title">' + escapeHtml(s.title || "") + '</td>'
  );
}

function sessionRow(s) {
  const tr = document.createElement("tr");
  tr.className = "row"; tr.dataset.id = s.native_id;
  tr.innerHTML = rowCells(s);
  tr.onclick = () => openDetail(s.native_id, tr);
  return tr;
}

const collapsed = new Set();

function render() {
  const tb = $("#rows"); tb.innerHTML = "";
  $("#empty").hidden = data.length > 0;
  const grouped = $("#group").value === "project";

  if (!grouped) {
    sortData();
    for (const s of data) tb.appendChild(sessionRow(s));
    return;
  }

  // Group by project; order groups by total cost desc, rows within by cost desc.
  const groups = new Map();
  for (const s of data) {
    const key = s.project || "(no project)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const sum = (rows) => rows.reduce((a, r) => a + (r.total_usd || 0), 0);
  const order = [...groups.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
  for (const [key, rows] of order) {
    rows.sort((a, b) => (b.total_usd ?? -1) - (a.total_usd ?? -1));
    const open = !collapsed.has(key);
    const hdr = document.createElement("tr");
    hdr.className = "grp";
    hdr.innerHTML = '<td colspan="6"><span class="gcar">' + (open ? "▾" : "▸") + '</span>' +
      '<span class="gname">' + escapeHtml(base(key)) + '</span>' +
      '<span class="gmeta">' + escapeHtml(key) + ' · ' + rows.length + ' sessions</span>' +
      '<span class="gcost">' + fmtUsd(sum(rows)) + '</span></td>';
    hdr.onclick = () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); render(); };
    tb.appendChild(hdr);
    if (open) for (const s of rows) tb.appendChild(sessionRow(s));
  }
}

function spark(buckets) {
  if (!buckets || !buckets.length) return "";
  const max = Math.max(...buckets, 1);
  return '<div class="spark">' + buckets.map(b => '<i style="height:' + Math.max(2, Math.round(30 * b / max)) + 'px"></i>').join("") + '</div>';
}

async function openDetail(id, tr) {
  document.querySelectorAll("tr.sel").forEach(e => e.classList.remove("sel"));
  tr.classList.add("sel");
  const d = $("#detail"); d.classList.add("open"); d.innerHTML = '<div class="sub">loading…</div>';
  const j = await (await fetch("/api/sessions/" + encodeURIComponent(id))).json();
  if (j.error) { d.innerHTML = '<div class="sub">not found</div>'; return; }
  let html = '<div class="dh">Session</div><h2>' + escapeHtml(j.session.title || j.session.native_id) + '</h2>';
  html += '<div class="sub">' + j.session.agent + ' · ' + escapeHtml(shorten(j.session.native_id)) + ' · total <span class="cost has">' + fmtUsd(j.total_usd) + '</span></div>';
  for (const m of j.models) {
    let buckets = []; try { buckets = JSON.parse(m.burn_buckets || "[]"); } catch {}
    html += '<div class="card"><div class="top"><span class="model">' + (m.model || "unknown") + (m.token_source === "byte_estimate" ? ' <span class="tag">EST</span>' : '') + '</span>' +
      '<span class="cost has">' + fmtUsd(m.total_usd) + '</span></div>' + spark(buckets) +
      '<div class="tk">in ' + fmtTok(m.input_tokens) + ' · out ' + fmtTok(m.output_tokens) + ' · cache read ' + fmtTok(m.cache_read_tokens) + '</div></div>';
  }
  // Cost by log batch — only when there's MORE THAN ONE log (with one, it just
  // restates the session total). Costs come from the worklog byte-span sums.
  if (j.worklog && j.worklog.length > 1) {
    html += '<div class="wl"><div class="dh">Cost by log batch</div>';
    for (const w of j.worklog) {
      html += '<div class="batch"><div class="brow"><b>' + escapeHtml(w.text) + '</b>' +
        '<span class="cost has">' + fmtUsd(w.cost_usd) + '</span></div>' +
        '<div class="tk">' + fmtTok(w.tokens) + ' tok · ' + (w.msg_count ?? "?") + ' msgs' + (w.body ? '</div><small>' + escapeHtml(w.body) + '</small>' : '</div>') + '</div>';
    }
    html += '</div>';
  } else if (j.worklog && j.worklog.length === 1) {
    const w = j.worklog[0];
    html += '<div class="wl"><div class="dh">Worklog</div><div class="e"><b>' + escapeHtml(w.text) + '</b>' + (w.body ? '<small>' + escapeHtml(w.body) + '</small>' : '') + '</div></div>';
  }

  // Conversation viewer (lazy, paged) — loaded only on demand so it's never heavy.
  html += '<div class="wl"><div class="dh">Conversation</div><div id="convo"><button class="btn" id="convoBtn">View conversation</button></div></div>';

  d.innerHTML = html;
  const btn = d.querySelector("#convoBtn");
  if (btn) btn.onclick = () => loadConvo(j.session.native_id, 0);
}

let convoMsgs = [];
async function loadConvo(id, offset) {
  const box = $("#convo");
  if (offset === 0) { convoMsgs = []; box.innerHTML = '<div class="sub">loading…</div>'; }
  const r = await (await fetch("/api/sessions/" + encodeURIComponent(id) + "/messages?offset=" + offset + "&limit=60")).json();
  convoMsgs = convoMsgs.concat(r.messages || []);
  let h = "";
  for (const mDel of convoMsgs) {
    const tools = (mDel.tools || []).map(t => '<span class="tchip">' + escapeHtml(t.summary || t.name) + '</span>').join(" ");
    h += '<div class="msg ' + mDel.role + '"><span class="who">' + mDel.role + '</span><div class="mtext">' + escapeHtml(mDel.text) + (tools ? '<div class="tools">' + tools + '</div>' : '') + '</div></div>';
  }
  const shown = convoMsgs.length;
  if (shown < r.total) h += '<button class="btn" id="moreBtn">Load more (' + shown + '/' + r.total + ')</button>';
  box.innerHTML = h;
  const more = box.querySelector("#moreBtn");
  if (more) more.onclick = () => loadConvo(id, shown);
}

function shorten(id) { return id.length > 18 ? id.slice(0, 8) + "…" + id.slice(-4) : id; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

document.querySelectorAll("th[data-sort]").forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
  render();
});

// Column resizing: drag the handle on a header's right edge to size its <col>.
(function initResize() {
  const cols = document.querySelectorAll("#tbl colgroup col");
  const ths = document.querySelectorAll("#tbl thead th");
  ths.forEach((th, i) => {
    if (i >= cols.length) return;
    const h = document.createElement("span");
    h.className = "rsz";
    h.onclick = (e) => e.stopPropagation(); // don't trigger sort
    h.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      h.classList.add("drag");
      const startX = e.clientX, col = cols[i], startW = col.getBoundingClientRect().width;
      const move = (ev) => { col.style.width = Math.max(40, startW + (ev.clientX - startX)) + "px"; };
      const up = () => { h.classList.remove("drag"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    th.appendChild(h);
  });
})();
$("#agent").onchange = () => { load(); if (curView === "insights") loadInsights(); };
$("#since").onchange = () => { load(); if (curView === "insights") loadInsights(); };
$("#group").onchange = render;

// --- Insights view ---------------------------------------------------------
let curView = "cost", insLoaded = false;
const insLabels = { "tool-freq": "Repeated tool calls", "tool-ngram": "Repeated sequences", "tool-errors": "Recurring errors" };

function showView(v) {
  curView = v;
  $("#costView").hidden = v !== "cost";
  $("#insightsView").hidden = v !== "insights";
  $("#tabCost").classList.toggle("on", v === "cost");
  $("#tabInsights").classList.toggle("on", v === "insights");
  $("#heroMode").textContent = v === "cost" ? "cost" : "insights";
  if (v === "insights" && !insLoaded) loadInsights();
}

async function loadInsights() {
  insLoaded = true;
  $("#status").textContent = "analyzing…";
  const qs = new URLSearchParams({ all: "true", top: "20" });
  const agent = $("#agent").value, since = $("#since").value;
  if (agent) qs.set("agent", agent);
  if (since) qs.set("since", since);
  let j;
  try { j = await (await fetch("/api/insights?" + qs)).json(); } catch { $("#status").textContent = "error"; return; }
  const groups = j.analyzers || {};
  let html = "";
  for (const name of ["tool-freq", "tool-ngram", "tool-errors"]) {
    const rows = groups[name] || [];
    html += '<div class="ins-g"><h3>' + (insLabels[name] || name) + '<span class="n">' + rows.length + '</span></h3>';
    if (!rows.length) html += '<div class="ins-note">nothing above the noise floor</div>';
    for (const r of rows) {
      const ex = (r.examples || []).map(e => e.session + (e.turn != null ? "#" + e.turn : "")).join("  ");
      html += '<div class="ins-row"><span class="num">' + fmtTok(r.count) + '×</span><span class="num">' + fmtTok(r.tokens) + '</span><span class="num">' + r.sessions + ' s</span>' +
        '<span class="key">' + escapeHtml(r.key) + (r.sample ? ' <span class="sample">«' + escapeHtml(r.sample) + '»</span>' : '') +
        (ex ? '<span class="ex">' + escapeHtml(ex) + '</span>' : '') + '</span></div>';
    }
    html += '</div>';
  }
  $("#insGroups").innerHTML = html;
  $("#status").textContent = "ready";
}

$("#tabCost").onclick = () => showView("cost");
$("#tabInsights").onclick = () => showView("insights");

load();

// Live reload: poll the page-content hash; reload when the UI source changes
// (pairs with \`bun --hot\`). Cheap local poll; only reloads on an actual change.
let __v = null;
setInterval(async () => {
  try { const r = await (await fetch("/api/ping")).json(); if (__v === null) __v = r.v; else if (r.v !== __v) location.reload(); } catch {}
}, 1500);
</script>
</body>
</html>`;
