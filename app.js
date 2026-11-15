/* Journal Feed — front end.
   Reads data/*.json written by the daily GitHub Action (and the optional
   Claude commentary), and streams an infinite "deep pool" of random
   high-quality papers straight from OpenAlex once you are caught up. */

const REPO = "drdoombg/Journal-Feed";
const OA = "https://api.openalex.org";
const DEFAULT_MAP = "https://drdoombg.github.io/Unified-Knowledge-Map/";

const $ = (s, el = document) => el.querySelector(s);
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------ storage -- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("jf." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("jf." + k, JSON.stringify(v)); } catch {} },
};
let votes = store.get("votes", {});   // id -> {v, d, issn, t}
let saved = store.get("saved", {});   // id -> item
let views = store.get("views", {});   // domain -> count (for under-explored weighting)

/* ------------------------------------------------------------ helpers -- */
let CFG = { domains: {}, journals: [] };
let ISSN = {};                         // issn -> journal
const shownIds = new Set();

function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
const fmtDate = d => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
const today = () => new Date().toISOString().slice(0, 10);

function absFromIndex(inv) {
  if (!inv) return "";
  const pos = [];
  for (const [w, idx] of Object.entries(inv)) for (const i of idx) pos.push([i, w]);
  pos.sort((a, b) => a[0] - b[0]);
  let t = pos.map(p => p[1]).join(" ").replace(/\s+/g, " ").trim().replace(/^(abstract|summary)[:.\s]+/i, "");
  return t.length > 1800 ? t.slice(0, 1790).replace(/\s\S*$/, "") + "…" : t;
}
const JUNK = /^(correction|corrigendum|erratum|retraction|editorial|in this issue|news|author correction|publisher correction|addendum|obituary|reply|response|letter to the editor|index|contents)\b/i;

/* --------------------------------------------------------------- card -- */
function card(it, opt = {}) {
  const col = CFG.domains[it.d] || "#888";
  const v = votes[it.id]?.v || 0;
  const isSaved = !!saved[it.id];
  const authors = it.authors?.length ? esc(it.authors.join(", ")) + (it.n_auth > it.authors.length ? " et al." : "") : "";
  const kind = it.review ? "Review" : "Article";
  const tags = [
    it.wildcard ? `<span class="tag wild">Wildcard</span>` : "",
    it.classic ? `<span class="tag">Classic</span>` : "",
    it.oa ? (/^(cc|public|pd)/i.test(it.license || "")
      ? `<span class="tag oa" title="Openly licensed: figures can be shown">Open access · ${esc((it.license || "").toUpperCase().replace(/^CC-/, "CC ").replace(/-/g, "‑"))}</span>`
      : `<span class="tag" title="Free to read, but not openly licensed, so figures can't be republished here">Free to read</span>`) : "",
    it.was_picked ? `<span class="tag oa">In your feed</span>` : "",
  ].join("");
  const c = it.cons;
  const fig = it.fig;
  const el = document.createElement("article");
  el.className = "card" + (opt.compact ? " compact" : "") + (opt.open ? " open" : "");
  el.dataset.id = it.id;
  el.innerHTML = `
    <div class="meta">
      <span class="dom" style="--c:${col}"><i></i>${esc(it.d)}</span>
      <span class="jn">${esc(it.journal)}</span>
      <span>${kind}</span>
      <span>${fmtDate(it.date)}</span>
      ${it.cited ? `<span>${it.cited.toLocaleString()} citations</span>` : ""}
      ${tags}
    </div>
    <h2><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h2>
    ${authors ? `<div class="authors">${authors}</div>` : ""}
    ${fig ? `<figure><div class="img"><img loading="lazy" src="${esc(fig.src)}" alt="${esc(fig.label)} from the paper"></div>
      <figcaption><b>${esc(fig.label)}</b>${fig.caption ? " | " + esc(fig.caption) : ""}<span class="credit">${esc(fig.credit || "")} · via ${esc(fig.via || "Europe PMC")}</span></figcaption></figure>
      ${it.fignote ? `<div class="block"><div class="h">Reading the figure</div><div class="fignote">${esc(it.fignote)}</div></div>` : ""}` : ""}
    ${it.note ? `<div class="block"><div class="h">${opt.noteLabel || "Why it matters"}</div><div class="note">${esc(it.note)}</div></div>` : ""}
    ${c ? `<dl class="cons"><dt>Question</dt><dd>${esc(c.question)}</dd><dt>Approach</dt><dd>${esc(c.approach)}</dd>
      <dt>Finding</dt><dd>${esc(c.finding)}</dd><dt>Implication</dt><dd>${esc(c.implication)}</dd></dl>` : ""}
    ${it.abstract ? `<div class="abs">${esc(it.abstract)}</div>` : ""}
    <div class="actions">
      ${it.abstract ? `<button data-a="abs">Abstract</button>` : `<span class="na">No abstract</span>`}
      ${it.oa_url ? `<a href="${esc(it.oa_url)}" target="_blank" rel="noopener">Full text</a>` : ""}
      <button data-a="share" title="Share the paper's link">Share</button>
      <button data-a="log" title="Copy for the knowledge map">Log</button>
      <span class="sp"></span>
      <button data-a="up" class="${v > 0 ? "on-up" : ""}" title="More like this">▲</button>
      <button data-a="down" class="${v < 0 ? "on-down" : ""}" title="Less like this">▼</button>
      <button data-a="save" class="${isSaved ? "on-save" : ""}" title="Save">${isSaved ? "Saved" : "Save"}</button>
    </div>`;
  const img = el.querySelector("figure img");
  if (img) {
    img.onerror = () => img.closest("figure").remove();
    img.addEventListener("click", () => openViewer(fig, it));
  }
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const a = b.dataset.a;
    if (a === "abs") { el.classList.toggle("open"); b.textContent = el.classList.contains("open") ? "Hide abstract" : "Abstract"; }
    if (a === "up" || a === "down") vote(it, a === "up" ? 1 : -1, el);
    if (a === "save") toggleSave(it, b);
    if (a === "log") logToMap(it);
    if (a === "share") sharePaper(it);
  });
  views[it.d] = (views[it.d] || 0) + 1;
  shownIds.add(it.id);
  return el;
}

/* ----------------------------------------------------- figure viewer --- */
/* Click a figure: full-screen view. Wheel or pinch to zoom, drag to pan,
   double-click to toggle 2.5x, click outside the image or Esc to close. */
function openViewer(fig, it) {
  const ov = document.createElement("div");
  ov.className = "viewer";
  ov.innerHTML = `
    <div class="v-stage"><img class="v-img" src="${esc(fig.src)}" alt="${esc(fig.label)}" draggable="false"></div>
    <div class="v-bar">
      <div class="v-cap"><b>${esc(fig.label)}</b>${fig.caption ? " | " + esc(fig.caption) : ""}
        <span class="credit">${esc(it.title)} · ${esc(fig.credit || "")}</span></div>
      <div class="v-ctl"><button data-z="-">−</button><span class="v-pct">100%</span><button data-z="+">+</button><button data-z="0">Fit</button><button data-z="x" title="Close (Esc)">✕</button></div>
    </div>`;
  document.body.append(ov);
  document.body.style.overflow = "hidden";
  const stage = ov.querySelector(".v-stage"), im = ov.querySelector(".v-img"), pct = ov.querySelector(".v-pct");
  let s = 1, x = 0, y = 0;
  const apply = () => { im.style.transform = `translate(${x}px,${y}px) scale(${s})`; pct.textContent = Math.round(s * 100) + "%"; im.style.cursor = s > 1 ? "grab" : "zoom-in"; };
  const zoomAt = (ns, cx, cy) => {               // keep the point under the cursor fixed
    ns = Math.min(8, Math.max(1, ns));
    const r = stage.getBoundingClientRect(), ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2;
    x = ox - (ox - x) * (ns / s); y = oy - (oy - y) * (ns / s); s = ns;
    if (s === 1) { x = 0; y = 0; }
    apply();
  };
  const close = () => { ov.remove(); document.body.style.overflow = ""; removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); if (e.key === "+" || e.key === "=") zoomAt(s * 1.25, innerWidth / 2, innerHeight / 2); if (e.key === "-") zoomAt(s / 1.25, innerWidth / 2, innerHeight / 2); };
  addEventListener("keydown", onKey);

  stage.addEventListener("wheel", e => { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  im.addEventListener("dblclick", e => zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY));

  // drag to pan (mouse + one finger), pinch to zoom (two fingers)
  const pts = new Map(); let moved = false, start = null, pinch = null;
  im.addEventListener("pointerdown", e => {
    e.preventDefault(); im.setPointerCapture(e.pointerId); pts.set(e.pointerId, e); moved = false;
    if (pts.size === 1) start = { px: e.clientX, py: e.clientY, x, y };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s }; }
    if (s > 1) im.style.cursor = "grabbing";
  });
  im.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      zoomAt(pinch.s * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      moved = true;
    } else if (start) {
      const dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (s > 1) { x = start.x + dx; y = start.y + dy; apply(); }
    }
  });
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { start = null; apply(); } };
  im.addEventListener("pointerup", up); im.addEventListener("pointercancel", up);
  im.addEventListener("click", e => { e.stopPropagation(); if (!moved && s === 1) zoomAt(2.5, e.clientX, e.clientY); });

  ov.querySelector(".v-ctl").addEventListener("click", e => {
    e.stopPropagation();
    const z = e.target.closest("[data-z]")?.dataset.z; if (!z) return;
    if (z === "x") return close();
    if (z === "0") { s = 1; x = 0; y = 0; apply(); return; }
    zoomAt(z === "+" ? s * 1.4 : s / 1.4, innerWidth / 2, innerHeight / 2);
  });
  ov.querySelector(".v-cap").addEventListener("click", e => e.stopPropagation());
  ov.addEventListener("click", close);            // anywhere that isn't the image or the controls
  apply();
}

function vote(it, val, el) {
  const cur = votes[it.id]?.v || 0;
  if (cur === val) {
    delete votes[it.id];
    store.set("unvoted", [...new Set([...store.get("unvoted", []), it.id])].slice(-500));
  } else votes[it.id] = { v: val, d: it.d, issn: it.issn, t: today() };
  store.set("votes", votes);
  const nv = votes[it.id]?.v || 0;
  el.querySelector('[data-a="up"]').className = nv > 0 ? "on-up" : "";
  el.querySelector('[data-a="down"]').className = nv < 0 ? "on-down" : "";
  scheduleSync();
}
function toggleSave(it, b) {
  if (saved[it.id]) { delete saved[it.id]; b.textContent = "Save"; b.className = ""; toast("Removed from saved"); }
  else { saved[it.id] = { ...it, savedAt: today() }; b.textContent = "Saved"; b.className = "on-save"; toast("Saved"); }
  store.set("saved", saved);
}
/* Share = the paper's link only. On a phone this opens the system share
   sheet (pick Claude, ChatGPT, any app); on desktop it copies the link. */
async function sharePaper(it) {
  const link = it.doi ? `https://doi.org/${it.doi}` : it.url;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ url: link }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(link); toast("Link copied — paste it into Claude"); }
  catch { prompt("Copy this link:", link); }
}

async function logToMap(it) {
  const yr = (it.date || "").slice(0, 4);
  const link = it.doi ? `https://doi.org/${it.doi}` : it.url;
  const text = `${it.title} — ${it.journal}${yr ? ` (${yr})` : ""} [${it.d}] ${link}`;
  try { await navigator.clipboard.writeText(text); toast(`Copied for ${it.d} — paste into the map`); }
  catch { prompt("Copy this into the knowledge map:", text); }
}

/* --------------------------------------------------------- vote sync -- */
let syncTimer;
function scheduleSync() {
  if (!store.get("token", "")) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(syncVotes, 4000);
}
async function syncVotes(manual) {
  const token = store.get("token", "");
  if (!token) { if (manual) toast("Add a GitHub token in Settings first"); return; }
  const api = `https://api.github.com/repos/${REPO}/contents/data/votes.json`;
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  try {
    let sha, remote = {};
    const r = await fetch(api, { headers: h, cache: "no-store" });
    if (r.ok) {
      const j = await r.json(); sha = j.sha;
      remote = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, "")))));
    }
    const merged = { ...remote, ...votes };
    // a vote removed locally should be removed remotely too
    for (const id of store.get("unvoted", [])) if (!votes[id]) delete merged[id];
    const body = {
      message: `votes: ${Object.keys(votes).length} local`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(merged, null, 1)))),
      ...(sha ? { sha } : {}),
    };
    const p = await fetch(api, { method: "PUT", headers: h, body: JSON.stringify(body) });
    if (!p.ok) throw new Error(p.status);
    votes = merged; store.set("votes", votes);
    store.set("lastSync", new Date().toISOString());
    if (manual) toast(`Synced ${Object.keys(merged).length} votes`);
  } catch (e) { if (manual) toast("Sync failed (" + e.message + ") — check the token"); }
}

/* ------------------------------------------------------------- today --- */
async function loadDay(date) {
  const day = await getJSON(date ? `data/days/${date}.json` : "data/latest.json", { cache: "no-store" });
  let com = null;
  try { com = await getJSON(`data/commentary/${day.date}.json`, { cache: "no-store" }); } catch {}
  let picks = day.picks;
  if (com) {
    const byId = {};
    for (const it of [...(day.shortlist || []), ...day.picks, ...(day.more || [])]) byId[it.id] = it;
    if (Array.isArray(com.order) && com.order.length) {
      const ordered = com.order.map(id => byId[id]).filter(Boolean);
      if (ordered.length >= 5) picks = ordered;
    }
    picks = picks.map(it => ({ ...it, note: com.notes?.[it.id] || it.note,
      cons: com.consolidation?.[it.id], fignote: com.figure_notes?.[it.id] }));
  }
  const pickIds = new Set(picks.map(p => p.id));
  const more = [...day.picks, ...(day.more || [])].filter(it => !pickIds.has(it.id));
  return { day, com, picks, more };
}

async function renderToday(date) {
  main.innerHTML = `<div class="loader">Loading…</div>`;
  let data;
  try { data = await loadDay(date); }
  catch {
    main.innerHTML = `<div class="empty">No feed yet. The first daily run hasn't published.<br><br>The deep pool still works:</div>`;
    $("#sub").textContent = "waiting for the first run";
    startDeepPool();
    return;
  }
  const { day, com, picks, more } = data;
  $("#sub").textContent = `${fmtDate(day.date)} · ${day.stats?.new ?? "?"} new papers scanned${com ? " · commentary ✓" : ""}`;
  main.innerHTML = "";
  if (com?.thread) {
    const t = document.createElement("div"); t.className = "thread";
    t.innerHTML = `<h3>Editor's note · today's thread</h3><p>${esc(com.thread)}</p>`; main.append(t);
  }
  main.insertAdjacentHTML("beforeend", `<div class="label">Top picks <span class="n">${picks.length}</span></div>`);
  picks.forEach(it => main.append(card(it)));
  if (more.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">Worth a look <span class="n">${more.length}</span></div>`);
    more.forEach(it => main.append(card(it, { compact: true })));
  }
  store.set("views", views);
  if (!date) startDeepPool();
  else main.insertAdjacentHTML("beforeend", `<div class="caught"><b>End of ${fmtDate(day.date)}</b></div>`);
}

/* --------------------------------------------------------- deep pool --- */
const MODES = ["recent", "classic", "review", "recent", "wild"];
const MODE_LABEL = { recent: "Recent standouts", classic: "Classics", review: "Reviews", wild: "Anything good",
  foundation: "Foundational classics", modern: "Modern foundations" };
let pool = { on: false, busy: false, i: 0, dead: false, io: null, journals: null, modes: MODES };

function startDeepPool(opt = {}) {
  const intro = opt.intro ?? `<div class="caught"><b>You're caught up.</b>Today's picks are done. Below is the deep pool:
    random papers from the same journals, weighted towards domains you've seen least.</div>`;
  main.insertAdjacentHTML("beforeend", `${intro}<div id="pool"></div><div class="loader" id="poolSentinel">…</div>`);
  pool = { on: true, busy: false, i: 0, dead: false, io: null, journals: opt.journals || null, modes: opt.modes || MODES };
  pool.io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadPool(); }, { rootMargin: "800px" });
  pool.io.observe($("#poolSentinel"));
}

function pickIssns(n) {
  // weight journals by how little their domain has been viewed
  const js = pool.journals || CFG.journals;
  const w = js.map(j => 1 / Math.sqrt(1 + (views[j.d] || 0)) * (j.t === 3 ? 1.4 : 1));
  const out = new Set();
  let guard = 0;
  while (out.size < Math.min(n, js.length) && guard++ < 500) {
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < js.length; k++) { r -= w[k]; if (r <= 0) { out.add(js[k].issn); break; } }
  }
  return [...out];
}

async function loadPool() {
  if (!pool.on || pool.busy || pool.dead) return;
  pool.busy = true;
  const mode = pool.modes[pool.i++ % pool.modes.length];
  const y = new Date().getFullYear();
  const f = [`primary_location.source.issn:${pickIssns(18).join("|")}`];
  if (mode === "foundation") f.push(`to_publication_date:${y - 10}-12-31`, "cited_by_count:>1500", "type:article|review");
  if (mode === "modern") f.push(`from_publication_date:${y - 10}-01-01`, "cited_by_count:>300", "type:article");
  if (mode === "recent") f.push(`from_publication_date:${y - 3}-01-01`, "cited_by_count:>25", "type:article|review");
  if (mode === "classic") f.push(`to_publication_date:${y - 6}-12-31`, "cited_by_count:>700", "type:article|review");
  if (mode === "review") f.push("type:review", "cited_by_count:>120");
  if (mode === "wild") f.push("cited_by_count:>90", "type:article|review");
  f.push("has_abstract:true");
  const url = `${OA}/works?filter=${f.join(",")}&sample=8&seed=${Math.floor(Math.random() * 1e6)}` +
    `&select=id,doi,title,publication_date,type,cited_by_count,abstract_inverted_index,authorships,open_access,primary_location,best_oa_location`;
  try {
    const res = await getJSON(url);
    const box = $("#pool");
    const items = (res.results || []).map(w => {
      const issns = w.primary_location?.source?.issn || [];
      const j = issns.map(i => ISSN[i]).find(Boolean) || { d: "Cross-domain", n: w.primary_location?.source?.display_name || "", issn: issns[0], t: 2 };
      const auths = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
      return {
        id: (w.id || "").split("/").pop(), doi: (w.doi || "").replace("https://doi.org/", ""),
        url: w.doi || w.primary_location?.landing_page_url || w.id,
        title: (w.title || "").replace(/<[^>]+>/g, ""), journal: j.n, issn: j.issn, d: j.d,
        date: w.publication_date, review: w.type === "review" || !!j.review, cited: w.cited_by_count || 0,
        authors: auths.slice(0, 4), n_auth: auths.length, abstract: absFromIndex(w.abstract_inverted_index),
        oa: !!w.open_access?.is_oa, oa_url: w.best_oa_location?.pdf_url || w.best_oa_location?.landing_page_url || "",
        classic: mode === "classic" || mode === "foundation",
      };
    }).filter(it => it.title && !JUNK.test(it.title) && !shownIds.has(it.id));
    if (items.length) {
      box.insertAdjacentHTML("beforeend", `<div class="pool-mode">${MODE_LABEL[mode]}</div>`);
      items.forEach(it => box.append(card(it, { compact: true })));
      store.set("views", views);
    }
  } catch (e) {
    pool.dead = true;
    $("#poolSentinel").innerHTML = e.message === "429"
      ? "The deep pool is resting: today's free OpenAlex quota for this device is used up. Back tomorrow."
      : "Couldn't reach OpenAlex right now. Pull to refresh later.";
  }
  pool.busy = false;
  // keep filling if the sentinel is still on screen
  const s = $("#poolSentinel");
  if (!pool.dead && s && s.getBoundingClientRect().top < innerHeight + 800) setTimeout(loadPool, 250);
}

/* ------------------------------------------------------ fundamentals --- */
const scholar = q => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;

async function renderFund() {
  stopPool();
  main.innerHTML = `<div class="loader">Loading…</div>`;
  let day = null, com = null;
  try { day = await getJSON("data/latest.json", { cache: "no-store" }); } catch {}
  if (day) { try { com = await getJSON(`data/commentary/${day.date}.json`, { cache: "no-store" }); } catch {} }
  main.innerHTML = "";

  // "foundation" (current schema); "upstream" kept for older files
  const fd = com?.foundation || (com?.upstream && { ...com.upstream, built_from: com.upstream.chain, rests_on: com.upstream.foundations });
  if (fd?.principle) {
    const byId = {};
    for (const it of [...(day.shortlist || []), ...day.picks, ...(day.more || []), ...(day.fundamentals || [])]) byId[it.id] = it;
    const built = (fd.built_from || []).map(id => byId[id]).filter(Boolean);
    const el = document.createElement("section"); el.className = "foundation";
    el.innerHTML = `
      <div class="kicker">Foundation · ${fmtDate(day.date)}</div>
      <h2>${esc(fd.title || "Today's principle")}</h2>
      <p>${esc(fd.principle)}</p>
      ${built.length ? `<div class="sub2">Built from today's papers</div><ol>${built.map(c => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> <span>${esc(c.journal)}</span></li>`).join("")}</ol>` : ""}
      ${fd.rests_on?.length ? `<div class="sub2">Rests on</div><ul>${fd.rests_on.map(f => `<li><a href="${scholar(f)}" target="_blank" rel="noopener">${esc(f)}</a></li>`).join("")}</ul>` : ""}
      ${fd.question ? `<div class="q"><b>Open question</b>${esc(fd.question)}</div>` : ""}`;
    main.append(el);
  } else {
    main.insertAdjacentHTML("beforeend", `<section class="foundation"><div class="kicker">Foundation</div><p style="color:var(--dim)">Today's foundation hasn't been written yet. Claude writes it each morning with the commentary.</p></section>`);
  }

  const cands = day?.fundamentals || [];
  const fnotes = com?.fundamentals?.notes || {};
  const fOrder = (com?.fundamentals?.order || []).filter(id => cands.some(c => c.id === id));
  const chosen = fOrder.length ? fOrder.map(id => cands.find(c => c.id === id)) : [];
  if (chosen.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">Shifts in the foundations <span class="n">${chosen.length}</span></div>`);
    chosen.forEach(it => main.append(card({ ...it, note: fnotes[it.id], fignote: com?.figure_notes?.[it.id] }, { noteLabel: "What it shifts" })));
  }
  const rest = cands.filter(c => !fOrder.includes(c.id));
  if (rest.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">${chosen.length ? "Other candidates" : "Foundational candidates"} <span class="n">nominated by rules, ${rest.length}</span></div>`);
    rest.forEach(it => main.append(card(it, { compact: true })));
  }
  if (!cands.length && !up) main.insertAdjacentHTML("beforeend", `<div class="empty">No fundamentals scanned yet. They arrive with the next daily run.</div>`);

  store.set("views", views);
  startDeepPool({
    journals: CFG.journals.filter(j => j.f || j.t === 3),
    modes: ["foundation", "modern", "foundation", "review"],
    intro: `<div class="caught"><b>Foundational classics</b>Endless papers that built today's foundations, from theory-oriented journals and flagships.</div>`,
  });
}

/* ----------------------------------------------------------- domains --- */
let DOMIDX = null;
async function renderDomains(dom) {
  stopPool();
  main.innerHTML = `<div class="loader">Loading…</div>`;
  if (!DOMIDX) { try { DOMIDX = await getJSON("data/domains.json", { cache: "no-store" }); } catch { DOMIDX = { domains: {} }; } }
  const doms = Object.keys(CFG.domains);
  if (!dom) {
    main.innerHTML = `<div class="label">Domains <span class="n">best papers scanned in the last 14 days</span></div><div class="dgrid">` +
      doms.map(d => {
        const n = (DOMIDX.domains[d] || []).length, col = CFG.domains[d];
        const js = CFG.journals.filter(j => j.d === d).length;
        return `<a class="dtile" href="#domain/${encodeURIComponent(d)}" style="--c:${col}">
          <b>${esc(d)}</b><span>${n} recent · ${js} journals</span></a>`;
      }).join("") + `</div>`;
    return;
  }
  const items = DOMIDX.domains[dom] || [];
  const col = CFG.domains[dom] || "#aaa";
  main.innerHTML = `<a class="back" href="#domains">← All domains</a>
    <div class="label" style="color:${col}">${esc(dom)} <span class="n">${items.length} recent papers</span></div>`;
  if (!items.length) main.insertAdjacentHTML("beforeend", `<div class="empty">Nothing scanned in this domain in the last 14 days yet.</div>`);
  items.forEach(it => main.append(card(it, { compact: true })));
  store.set("views", views);
  startDeepPool({
    journals: CFG.journals.filter(j => j.d === dom),
    modes: ["recent", "classic", "review", "wild"],
    intro: `<div class="caught"><b>More from ${esc(dom)}</b>Endless papers from this domain's journals: recent standouts, classics and reviews.</div>`,
  });
}

/* ------------------------------------------------------ food industry --- */
const FOOD_REFS = [
  ["Regulation (EC) No 2073/2005: microbiological criteria for foodstuffs (UK version, Annex I)", "https://www.legislation.gov.uk/eur/2005/2073/annexes", "legislation.gov.uk"],
  ["UKHSA guidelines for assessing the microbiological safety of ready-to-eat foods (2024)", "https://assets.publishing.service.gov.uk/media/66debd72e87ad2f1218265e1/UKHSA-ready-to-eat-guidelines-2024.pdf", "UKHSA · PDF"],
  ["Campden BRI guidelines: sampling, HACCP, shelf life, cleaning and disinfection", "https://www.campdenbri.co.uk/publications/pubs.php", "Campden BRI · paid"],
  ["BRCGS Global Standard Food Safety (Issue 9)", "https://www.brcgs.com/", "BRCGS"],
  ["FSA food and allergy alerts (official data feed)", "https://data.food.gov.uk/food-alerts/ui/reference", "Food Standards Agency"],
  ["EFSA Journal: scientific opinions on Salmonella, Campylobacter, Listeria", "https://efsa.onlinelibrary.wiley.com/journal/18314732", "EFSA"],
];

async function renderFood() {
  stopPool();
  main.innerHTML = `<div class="loader">Loading…</div>`;
  let day = null, work = null;
  try { day = await getJSON("data/latest.json", { cache: "no-store" }); } catch {}
  try { work = await getJSON("data/work.json", { cache: "no-store" }); } catch {}
  if (!DOMIDX) { try { DOMIDX = await getJSON("data/domains.json", { cache: "no-store" }); } catch { DOMIDX = { domains: {} }; } }
  main.innerHTML = `<section class="foundation" style="border-top-color:${CFG.domains["Food industry"] || "var(--ink)"}">
      <div class="kicker">Food industry</div>
      <h2>Poultry, food safety and microbiology</h2>
      <p>New research from the poultry and food-safety journals, the latest UK guidance and FSA alerts, and the standards you work to.</p></section>`;

  const alerts = work?.alerts || [];
  if (alerts.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">FSA alerts <span class="n">last 60 days</span></div><div class="list">` +
      alerts.slice(0, 10).map(a => `<a class="row" href="${esc(a.url)}" target="_blank" rel="noopener">
        <span><small class="kind">${esc(a.kind)}</small>${esc(a.title)}</span><span>${fmtDate(a.date)}</span></a>`).join("") + `</div>`);
  }
  const gov = work?.govuk || [];
  if (gov.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">New UK guidance <span class="n">GOV.UK · last 120 days</span></div><div class="list">` +
      gov.slice(0, 12).map(g => `<a class="row" href="${esc(g.url)}" target="_blank" rel="noopener">
        <span><small class="kind">${esc((g.orgs || []).join(", "))}${g.format ? " · " + esc(g.format) : ""}</small>${esc(g.title)}</span><span>${fmtDate(g.date)}</span></a>`).join("") + `</div>`);
  }
  if (!alerts.length && !gov.length) main.insertAdjacentHTML("beforeend", `<div class="empty">Guidance and alerts arrive with the next daily run.</div>`);

  const today = day?.food || [];
  if (today.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">Today's research <span class="n">${today.length} papers</span></div>`);
    today.forEach(it => main.append(card(it, { compact: true })));
  }
  const ids = new Set(today.map(x => x.id));
  const recent = (DOMIDX.domains["Food industry"] || []).filter(x => !ids.has(x.id));
  if (recent.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">Last 14 days <span class="n">${recent.length} papers</span></div>`);
    recent.forEach(it => main.append(card(it, { compact: true })));
  }

  main.insertAdjacentHTML("beforeend", `<div class="label">Standards and guidelines</div><div class="list">` +
    FOOD_REFS.map(([t, u, src]) => `<a class="row" href="${u}" target="_blank" rel="noopener"><span>${esc(t)}</span><span>${esc(src)}</span></a>`).join("") + `</div>`);

  store.set("views", views);
  startDeepPool({
    journals: CFG.journals.filter(j => j.d === "Food industry"),
    modes: ["recent", "review", "classic", "wild"],
    intro: `<div class="caught"><b>More from the food-safety journals</b>Endless papers: recent standouts, reviews and classics.</div>`,
  });
}

/* ---------------------------------------------------------- archive --- */
async function renderArchive() {
  stopPool();
  main.innerHTML = `<div class="loader">Loading…</div>`;
  try {
    const idx = await getJSON("data/index.json", { cache: "no-store" });
    if (!idx.days?.length) throw 0;
    main.innerHTML = `<div class="label">Past days <span class="n">${idx.days.length}</span></div><div class="list">` +
      idx.days.map(d => `<a class="row" href="#day/${d}"><span>${fmtDate(d)}</span><span>${d === today() ? "today" : "→"}</span></a>`).join("") + `</div>`;
  } catch { main.innerHTML = `<div class="empty">No days archived yet.</div>`; }
}

async function renderRetro(tag) {
  stopPool();
  main.innerHTML = `<div class="loader">Loading…</div>`;
  try {
    if (!tag) {
      const idx = await getJSON("data/retro/index.json", { cache: "no-store" });
      if (!idx.retros?.length) throw 0;
      main.innerHTML = `<div class="label">What actually mattered</div><div class="list">` +
        idx.retros.map(t => `<a class="row" href="#retro/${t}"><span>${esc(t.replace(/-(monthly|quarterly)$/, " · $1"))}</span><span>→</span></a>`).join("") + `</div>`;
      return;
    }
    const r = await getJSON(`data/retro/${tag}.json`, { cache: "no-store" });
    main.innerHTML = `<div class="label">${esc(r.kind)} retro <span class="n">papers from ${fmtDate(r.window[0])} – ${fmtDate(r.window[1])}, ranked by citations so far · daily picks caught ${r.caught}/${r.total}</span></div>`;
    r.items.forEach(it => main.append(card(it, { compact: true })));
  } catch {
    main.innerHTML = `<div class="empty">No retros yet.<br>The monthly pass runs on the 1st of each month, and the quarterly on 1 Jan, Apr, Jul and Oct.</div>`;
  }
}

function renderSaved() {
  stopPool();
  const items = Object.values(saved).sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  main.innerHTML = items.length ? `<div class="label">Saved <span class="n">${items.length}</span></div>` : `<div class="empty">Nothing saved yet. Tap ☆ on any paper.</div>`;
  items.forEach(it => main.append(card(it, { compact: true })));
}

function renderSettings() {
  stopPool();
  const nv = Object.keys(votes).length, up = Object.values(votes).filter(v => v.v > 0).length;
  const last = store.get("lastSync", "");
  main.innerHTML = `
    <div class="set"><h3>Vote sync</h3>
      <p>Your 👍/👎 tune tomorrow's ranking, but only once they reach the repo. Paste a GitHub fine-grained token with
      <b>Contents: read and write</b> on <b>${REPO}</b> only. It's stored on this device and nowhere else.</p>
      <input id="tok" type="password" placeholder="github_pat_…" value="${esc(store.get("token", ""))}">
      <button class="btn" id="saveTok">Save token</button> <button class="btn" id="syncNow">Sync now</button>
      <p class="kv" style="margin-top:12px"><span>Votes on this device</span><b>${nv} (${up} 👍, ${nv - up} 👎)</b>
      <span>Last sync</span><b>${last ? new Date(last).toLocaleString() : "never"}</b></p></div>
    <div class="set"><h3>Knowledge map</h3><p>"Log" copies a formatted line for the map. Open the map here:</p>
      <a class="btn" style="display:inline-block;text-decoration:none" href="${DEFAULT_MAP}" target="_blank" rel="noopener">Open Unified Knowledge Map ↗</a></div>
    <div class="set"><h3>Install</h3><p>On your phone, use the browser menu → <b>Add to Home screen</b>. It then opens like an app.</p></div>
    <div class="set"><h3>Domain exposure</h3><p>How much of each domain you've seen. The deep pool leans towards the low ones.</p>
      <div class="kv">${Object.keys(CFG.domains).map(d => `<span>${esc(d)}</span><b>${views[d] || 0}</b>`).join("")}</div></div>`;
  $("#saveTok").onclick = () => { store.set("token", $("#tok").value.trim()); toast("Token saved on this device"); };
  $("#syncNow").onclick = () => syncVotes(true);
}

function stopPool() { pool.on = false; pool.io?.disconnect(); }

/* ------------------------------------------------------------ router --- */
function route() {
  const h = location.hash.slice(1);
  const [tab, arg] = h.split("/");
  const active = tab === "day" ? "archive" : tab === "domain" ? "domains" : (tab || "today");
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === active));
  shownIds.clear();
  window.scrollTo(0, 0);
  if (!tab || tab === "today") return renderToday();
  if (tab === "day") { stopPool(); return renderToday(arg); }
  if (tab === "fund") return renderFund();
  if (tab === "food") return renderFood();
  if (tab === "domains") return renderDomains();
  if (tab === "domain") return renderDomains(decodeURIComponent(arg || ""));
  if (tab === "archive") return renderArchive();
  if (tab === "retro") return renderRetro(arg);
  if (tab === "saved") return renderSaved();
  if (tab === "settings") return renderSettings();
}
$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  location.hash = b.dataset.tab === "today" ? "" : b.dataset.tab;
  if (b.dataset.tab === "today") route();
});
addEventListener("hashchange", route);

(async function boot() {
  try {
    CFG = await getJSON("journals.json");
    for (const j of CFG.journals) ISSN[j.issn] = j;
  } catch {}
  route();
  getJSON("data/latest.json", { cache: "no-store" }).then(d => {
    const s = $("#sub"); if (s.textContent === "loading…") s.textContent = `${fmtDate(d.date)} · ${d.stats?.new ?? "?"} new papers scanned`;
  }).catch(() => { const s = $("#sub"); if (s.textContent === "loading…") s.textContent = "waiting for the first run"; });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
