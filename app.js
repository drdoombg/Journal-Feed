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
  const col = CFG.domains[it.d] || "#aaa";
  const v = votes[it.id]?.v || 0;
  const isSaved = !!saved[it.id];
  const authors = it.authors?.length ? esc(it.authors.join(", ")) + (it.n_auth > it.authors.length ? " et al." : "") : "";
  const badges = [
    it.wildcard ? `<span class="badge wild">WILDCARD</span>` : "",
    it.classic ? `<span class="badge classic">CLASSIC</span>` : "",
    it.review ? `<span class="badge review">REVIEW</span>` : "",
    it.oa ? `<span class="badge oa">OPEN</span>` : "",
    it.was_picked ? `<span class="badge hit">YOU SAW IT</span>` : "",
  ].join("");
  const cited = it.cited ? `<span>${it.cited.toLocaleString()} cites</span>` : "";
  const el = document.createElement("article");
  el.className = "card" + (opt.compact ? " compact" : "") + (opt.open ? " open" : "");
  el.dataset.id = it.id;
  el.innerHTML = `
    <div class="meta">
      <span class="chip" style="color:${col};border-color:${col}55">${esc(it.d)}</span>
      <span>${esc(it.journal)}</span><span>${fmtDate(it.date)}</span>${cited}${badges}
    </div>
    <h2><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h2>
    ${authors ? `<div class="authors">${authors}</div>` : ""}
    ${it.note ? `<div class="note">${esc(it.note)}</div>` : ""}
    ${it.abstract ? `<div class="abs">${esc(it.abstract)}</div>` : ""}
    <div class="actions">
      ${it.abstract ? `<button data-a="abs">Abstract ▾</button>` : `<span style="padding:7px 9px;color:var(--dimmer);font-size:12.5px">no abstract</span>`}
      <span class="sp"></span>
      <button data-a="up" class="${v > 0 ? "on-up" : ""}" title="More like this">👍</button>
      <button data-a="down" class="${v < 0 ? "on-down" : ""}" title="Less like this">👎</button>
      <button data-a="save" class="${isSaved ? "on-save" : ""}" title="Save">${isSaved ? "★" : "☆"}</button>
      <button data-a="log" title="Copy for knowledge map">Log</button>
      ${it.oa_url ? `<a href="${esc(it.oa_url)}" target="_blank" rel="noopener" title="Open-access copy">PDF</a>` : ""}
    </div>`;
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const a = b.dataset.a;
    if (a === "abs") { el.classList.toggle("open"); b.textContent = el.classList.contains("open") ? "Abstract ▴" : "Abstract ▾"; }
    if (a === "up" || a === "down") vote(it, a === "up" ? 1 : -1, el);
    if (a === "save") toggleSave(it, b);
    if (a === "log") logToMap(it);
  });
  views[it.d] = (views[it.d] || 0) + 1;
  shownIds.add(it.id);
  return el;
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
  if (saved[it.id]) { delete saved[it.id]; b.textContent = "☆"; b.className = ""; toast("Removed from saved"); }
  else { saved[it.id] = { ...it, savedAt: today() }; b.textContent = "★"; b.className = "on-save"; toast("Saved"); }
  store.set("saved", saved);
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
    picks = picks.map(it => ({ ...it, note: com.notes?.[it.id] || it.note }));
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
    t.innerHTML = `<h3>Today's thread</h3><p>${esc(com.thread)}</p>`; main.append(t);
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

  const up = com?.upstream;
  if (up?.principle) {
    const byId = {};
    for (const it of [...(day.shortlist || []), ...day.picks, ...(day.more || []), ...(day.fundamentals || [])]) byId[it.id] = it;
    const chain = (up.chain || []).map(id => byId[id]).filter(Boolean);
    const el = document.createElement("div"); el.className = "upstream";
    el.innerHTML = `
      <h3>Upstream · ${esc(up.title || "today's principle")}</h3>
      <p>${esc(up.principle)}</p>
      ${chain.length ? `<div class="up-sub">Climbed from</div><ul>${chain.map(c => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> <span>${esc(c.journal)}</span></li>`).join("")}</ul>` : ""}
      ${up.foundations?.length ? `<div class="up-sub">The foundations underneath</div><ul>${up.foundations.map(f => `<li><a href="${scholar(f)}" target="_blank" rel="noopener">${esc(f)}</a></li>`).join("")}</ul>` : ""}
      ${up.question ? `<div class="up-q"><b>Open question:</b> ${esc(up.question)}</div>` : ""}`;
    main.append(el);
  } else {
    main.insertAdjacentHTML("beforeend", `<div class="upstream"><h3>Upstream</h3><p style="color:var(--dim)">Today's upstream card hasn't been written yet. Claude writes it each morning along with the commentary.</p></div>`);
  }

  const cands = day?.fundamentals || [];
  const fnotes = com?.fundamentals?.notes || {};
  const fOrder = (com?.fundamentals?.order || []).filter(id => cands.some(c => c.id === id));
  const chosen = fOrder.length ? fOrder.map(id => cands.find(c => c.id === id)) : [];
  if (chosen.length) {
    main.insertAdjacentHTML("beforeend", `<div class="label">Shifts in the foundations <span class="n">${chosen.length}</span></div>`);
    chosen.forEach(it => main.append(card({ ...it, note: fnotes[it.id] })));
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
