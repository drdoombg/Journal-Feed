#!/usr/bin/env python3
"""
Journal Feed — daily fetch + rank engine.

Pulls new research articles and reviews from the journals in journals.json via
the OpenAlex API, filters out non-research items, scores and diversifies them,
and writes:

  data/days/YYYY-MM-DD.json   today's picks, worth-a-look tier, Claude shortlist
  data/latest.json            copy of today's file
  data/index.json             list of available days
  data/seen.json              ids already shown (so nothing repeats)
  data/sources.json           cached ISSN -> OpenAlex source id
  data/retro/*.json           monthly / quarterly "what actually mattered"

Standard library only. Set OPENALEX_API_KEY for the free 100k-credit tier;
without a key OpenAlex still answers on a small daily demo budget, which is
enough for one daily run of this script.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
API = "https://api.openalex.org"
KEY = os.environ.get("OPENALEX_API_KEY", "").strip()

N_PICKS = 10            # top tier, gets Claude commentary
N_MORE = 40             # worth-a-look tier
N_SHORTLIST = 60        # what Claude chooses the top 10 from
WINDOW_BACK = 14        # days back from today (publication_date)
WINDOW_FWD = 45         # print issues are often dated in the future
SEEN_DAYS = 120

SELECT = ",".join([
    "id", "doi", "title", "publication_date", "type", "cited_by_count",
    "abstract_inverted_index", "authorships", "open_access", "primary_topic",
    "primary_location", "best_oa_location", "ids", "locations",
])

JUNK = re.compile(
    r"^(correction|corrigendum|erratum|errata|retraction|retracted|expression of concern|"
    r"editorial|editor'?s note|in this issue|this week|news|news in brief|research highlights?|"
    r"author correction|publisher correction|addendum|obituary|in memoriam|books? (received|in brief)|"
    r"reply|response|letter to the editor|corrections?|front matter|back matter|table of contents|"
    r"masthead|cover|announcement|call for papers|reviewer acknowledg|acknowledg?ment of reviewers|"
    r"index|contents|issue information)\b",
    re.I,
)


# ---------------------------------------------------------------- http ------

CALLS = {"n": 0}


def get_json(path, params=None, allow_404=False):
    params = dict(params or {})
    if KEY:
        params["api_key"] = KEY
    url = API + path + ("?" + urllib.parse.urlencode(params, safe=":|,<>") if params else "")
    for attempt in range(4):
        try:
            CALLS["n"] += 1
            req = urllib.request.Request(url, headers={"User-Agent": "journal-feed/1.0 (github.com/drdoombg/Journal-Feed)"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404 and allow_404:
                return None
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt * 2)
                continue
            print(f"  ! HTTP {e.code} for {path} {params.get('filter','')}", file=sys.stderr)
            return None
        except Exception as e:  # network hiccup
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            print(f"  ! {type(e).__name__}: {e} for {path}", file=sys.stderr)
            return None
        finally:
            time.sleep(0.12)
    return None


# --------------------------------------------------------------- files ------

def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj, pretty=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


# ------------------------------------------------------------- helpers ------

def short_id(oa_id):
    return (oa_id or "").rsplit("/", 1)[-1]


def abstract_from_index(inv):
    if not inv:
        return ""
    pos = []
    for word, idxs in inv.items():
        for i in idxs:
            pos.append((i, word))
    pos.sort()
    text = " ".join(w for _, w in pos)
    text = re.sub(r"\s+", " ", text).strip()
    # strip publisher boilerplate that sometimes leads the abstract
    text = re.sub(r"^(abstract|summary)[:.\s]+", "", text, flags=re.I)
    return text


def clip(s, n):
    s = s or ""
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def jitter(key):
    return int(hashlib.md5(key.encode()).hexdigest()[:6], 16) / 0xFFFFFF


# ------------------------------------------------------------- sources ------

def resolve_sources(journals):
    cache_path = os.path.join(DATA, "sources.json")
    cache = load(cache_path, {})
    changed = False
    for j in journals:
        issn = j["issn"]
        if issn in cache and cache[issn].get("id"):
            continue
        src = get_json(f"/sources/issn:{issn}", allow_404=True)
        how = "issn"
        if not src or not src.get("id"):
            res = get_json("/sources", {"search": j["n"], "per_page": 1})
            src = (res or {}).get("results", [None])[0] if res else None
            how = "name"
        if src and src.get("id"):
            cache[issn] = {"id": short_id(src["id"]), "name": src.get("display_name"), "how": how}
            print(f"  resolved {j['n']!r} -> {src.get('display_name')!r} ({how})")
        else:
            cache[issn] = {"id": None, "name": None, "how": "failed"}
            print(f"  ! could not resolve {j['n']!r} ({issn})", file=sys.stderr)
        changed = True
    if changed:
        save(cache_path, cache, pretty=True)
    return cache


# --------------------------------------------------------------- items ------

def to_item(w, j):
    loc = w.get("primary_location") or {}
    oa = w.get("open_access") or {}
    best = w.get("best_oa_location") or {}
    auths = [a.get("author", {}).get("display_name") for a in (w.get("authorships") or [])]
    auths = [a for a in auths if a]
    doi = w.get("doi") or ""
    url = doi or loc.get("landing_page_url") or w.get("id")
    topic = (w.get("primary_topic") or {}).get("display_name")
    return {
        "id": short_id(w.get("id")),
        "doi": doi.replace("https://doi.org/", "") if doi else "",
        "url": url,
        "title": re.sub(r"<[^>]+>", "", w.get("title") or "").strip(),
        "journal": j["n"],
        "issn": j["issn"],
        "d": j["d"],
        "tier": j["t"],
        "f": 1 if j.get("f") else 0,
        "date": w.get("publication_date"),
        "type": w.get("type"),
        "review": bool(w.get("type") == "review" or j.get("review")),
        "cited": w.get("cited_by_count") or 0,
        "authors": auths[:4],
        "n_auth": len(auths),
        "abstract": clip(abstract_from_index(w.get("abstract_inverted_index")), 1800),
        "oa": bool(oa.get("is_oa")),
        "oa_url": best.get("pdf_url") or best.get("landing_page_url") or oa.get("oa_url") or "",
        "license": (best.get("license") or "").lower(),
        "pmcid": short_id((w.get("ids") or {}).get("pmcid") or ""),
        "arxiv": arxiv_id(w),
        "topic": topic or "",
    }


def arxiv_id(w):
    for loc in (w.get("locations") or []):
        for u in (loc.get("landing_page_url") or "", loc.get("pdf_url") or ""):
            m = re.search(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})", u or "")
            if m:
                return m.group(1)
    return ""


def is_research(it):
    t = it["title"]
    if not t or JUNK.match(t):
        return False
    if it["type"] not in ("article", "review"):
        return False
    words = len(t.split())
    if it["abstract"]:
        return words >= 3
    # no abstract: some publishers withhold them. Keep only things that look
    # like research papers rather than news/comment pieces.
    if it["review"]:
        return words >= 4
    return it["n_auth"] >= 3 and words >= 6


def score(it, bias):
    s = {3: 30.0, 2: 20.0}.get(it["tier"], 15.0)
    if it["review"]:
        s += 10
    s += 4 if it["abstract"] else -4
    s += 3.0 * math.log1p(it["cited"])
    if it["oa"]:
        s += 1
    if it["n_auth"] >= 3:
        s += 1
    s += 2.0 * bias["domain"].get(it["d"], 0)
    s += 1.5 * bias["journal"].get(it["issn"], 0)
    s += 2.0 * jitter(it["id"])          # tie-breaker, stable per paper
    return round(s, 2)


# Fundamentals: research that changes the foundations a field rests on, rather
# than extending it. Rules can only nominate; Claude makes the final call.
FUND_POS = [
    (r"\btheor(y|ies|em|ems|etical framework)\b", 4), (r"\bconjecture\b", 5), (r"\bproof\b|\bwe prove\b", 4),
    (r"\bprinciples?\b", 3), (r"\buniversal(ity)?\b", 4), (r"\bunif(y|ied|ying|ication)\b", 5),
    (r"\bfirst[- ]principles?\b", 5), (r"\bfundamental\b", 3), (r"\bparadigm\b", 3), (r"\bfoundations?\b", 3),
    (r"\borigins? of\b", 3), (r"\bemergen(ce|t)\b", 3), (r"\bsymmetr(y|ies)\b", 2), (r"\binvarian(t|ce)\b", 2),
    (r"\blaws? of\b|\bscaling laws?\b", 3), (r"\bgeneral (theory|framework|mechanism|principle)\b", 5),
    (r"\bwe (propose|develop|introduce) a (new |general |unified |formal )?(theory|framework|model of)\b", 5),
    (r"\bexplains? why\b|\bwhy (do|does|is|are)\b", 3), (r"\bcounterintuitive|paradox\b", 3),
    (r"\bchallenges? the (view|assumption|consensus)\b|\bcontrary to\b|\boverturn", 5),
    (r"\bmechanis(m|ms|tic)\b", 1), (r"\banalytic(al|ally)?\b", 1), (r"\bconceptual\b", 2),
    (r"\bminimal model\b|\bsimple rules?\b", 4), (r"\bthermodynamic|entropy|information[- ]theor", 2),
]
FUND_NEG = [
    (r"\bcohort\b|\bpatients?\b|\brandomi[sz]ed\b|\btrial\b", 3), (r"\bcase (study|report)\b", 4),
    (r"\bbenchmark\b|\bdataset\b|\bsurvey (data|of)\b", 2), (r"\bwe report\b", 1),
    (r"\bdevice\b|\bperformance\b|\befficiency\b|\byield\b", 1), (r"\bguideline|recommendation", 3),
    (r"\bprevalence\b|\bincidence\b|\bcost[- ]effective", 3),
]


def fund_score(it):
    if not it["abstract"]:
        return 0.0
    text = (it["title"] + " " + it["abstract"]).lower()
    s = sum(w for pat, w in FUND_POS if re.search(pat, text))
    s -= sum(w for pat, w in FUND_NEG if re.search(pat, text))
    if it.get("f"):
        s += 6
    if it["review"]:
        s += 1
    s += 1.0 * math.log1p(it["cited"])
    s += 1.0 * jitter("f" + it["id"])
    return round(s, 2)


def vote_bias():
    """data/votes.json is written by the app: {id: {v: 1|-1, d, issn, t}}"""
    votes = load(os.path.join(DATA, "votes.json"), {})
    dom, jou = {}, {}
    for v in votes.values():
        val = v.get("v", 0)
        if v.get("d"):
            dom[v["d"]] = dom.get(v["d"], 0) + val
        if v.get("issn"):
            jou[v["issn"]] = jou.get(v["issn"], 0) + val
    squash = lambda x: max(-4.0, min(4.0, 4.0 * math.tanh(x / 6.0)))
    return {"domain": {k: squash(x) for k, x in dom.items()},
            "journal": {k: squash(x) for k, x in jou.items()}}


def pick_diverse(items, n, per_journal, per_domain, exclude=()):
    out, jc, dc = [], {}, {}
    ex = set(exclude)
    for it in items:
        if it["id"] in ex:
            continue
        if jc.get(it["issn"], 0) >= per_journal or dc.get(it["d"], 0) >= per_domain:
            continue
        out.append(it)
        jc[it["issn"]] = jc.get(it["issn"], 0) + 1
        dc[it["d"]] = dc.get(it["d"], 0) + 1
        if len(out) >= n:
            break
    return out


# ---------------------------------------------------------------- daily -----

def daily(today, cfg):
    journals = cfg["journals"]
    sources = resolve_sources(journals)
    seen = load(os.path.join(DATA, "seen.json"), {})
    bias = vote_bias()

    lo = (today - dt.timedelta(days=WINDOW_BACK)).isoformat()
    hi = (today + dt.timedelta(days=WINDOW_FWD)).isoformat()

    everything, n_raw = {}, 0          # all research items in the window
    for j in journals:
        sid = (sources.get(j["issn"]) or {}).get("id")
        if not sid:
            continue
        res = get_json("/works", {
            "filter": f"primary_location.source.id:{sid},from_publication_date:{lo},to_publication_date:{hi},type:article|review",
            "sort": "publication_date:desc",
            "per_page": 100,
            "select": SELECT,
        })
        for w in (res or {}).get("results", []):
            n_raw += 1
            it = to_item(w, j)
            if not is_research(it):
                continue
            it["score"] = score(it, bias)
            it["fs"] = fund_score(it)
            if it["id"] not in everything or everything[it["id"]]["score"] < it["score"]:
                everything[it["id"]] = it

    pool = sorted((it for it in everything.values() if it["id"] not in seen), key=lambda x: -x["score"])
    print(f"  {n_raw} raw works, {len(everything)} research items, {len(pool)} not yet shown")

    fundamentals = pick_diverse(sorted((it for it in everything.values() if it["fs"] >= 8),
                                       key=lambda x: -x["fs"]), 25, per_journal=4, per_domain=5)
    update_domain_index(today, everything)

    day_path = os.path.join(DATA, "days", f"{today.isoformat()}.json")
    existing = load(day_path, None)
    if existing and existing.get("picks") and not FORCE["on"]:
        # same-day rerun: keep the picks (commentary refers to them), refresh the extras
        existing["fundamentals"] = fundamentals
        for lst in ("picks", "more", "shortlist"):
            for it in existing.get(lst, []):
                fresh = everything.get(it["id"])
                if fresh:
                    for k in ("license", "pmcid", "arxiv", "oa", "oa_url"):
                        it[k] = fresh.get(k, it.get(k))
        attach_figures(existing["picks"] + existing.get("more", []) + existing.get("shortlist", []) + fundamentals)
        existing.setdefault("stats", {})["calls_rerun"] = CALLS["n"]
        save(day_path, existing)
        save(os.path.join(DATA, "latest.json"), existing)
        print(f"  kept today's picks; refreshed {len(fundamentals)} fundamentals and the domain index")
        return

    # wildcard: best paper from the domain least represented in recent picks
    recent = {}
    idx = load(os.path.join(DATA, "index.json"), {"days": []})
    for day in idx.get("days", [])[:14]:
        f = load(os.path.join(DATA, "days", f"{day}.json"), {})
        for p in f.get("picks", []):
            recent[p["d"]] = recent.get(p["d"], 0) + 1

    picks = pick_diverse(pool, N_PICKS - 1, per_journal=2, per_domain=2)
    taken = {p["id"] for p in picks}
    used_domains = {p["d"] for p in picks}
    cand_domains = sorted({it["d"] for it in pool if it["d"] not in used_domains},
                          key=lambda d: (recent.get(d, 0), d))
    wildcard = None
    for d in cand_domains:
        wildcard = next((it for it in pool if it["d"] == d and it["id"] not in taken), None)
        if wildcard:
            break
    if wildcard:
        wildcard = dict(wildcard, wildcard=True)
        picks.append(wildcard)
        taken.add(wildcard["id"])
    elif len(pool) > len(picks):
        extra = pick_diverse(pool, 1, per_journal=3, per_domain=3, exclude=taken)
        picks += extra
        taken |= {e["id"] for e in extra}

    more = pick_diverse(pool, N_MORE, per_journal=4, per_domain=8, exclude=taken)
    shortlist_ids = [it["id"] for it in pick_diverse(pool, N_SHORTLIST, per_journal=4, per_domain=8)]
    for it in picks:                      # the default picks are always candidates
        if it["id"] not in shortlist_ids:
            shortlist_ids.append(it["id"])

    by_id = {it["id"]: it for it in pool}
    attach_figures(picks + more + [by_id[i] for i in shortlist_ids if i in by_id] + fundamentals)
    out = {
        "date": today.isoformat(),
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats": {"raw": n_raw, "new": len(pool), "calls": CALLS["n"], "journals": len(journals)},
        "picks": picks,
        "more": more,
        "shortlist": [by_id[i] for i in shortlist_ids if i in by_id],
        "fundamentals": fundamentals,
    }

    save(day_path, out)
    save(os.path.join(DATA, "latest.json"), out)

    days = [d for d in idx.get("days", []) if d != today.isoformat()]
    idx["days"] = [today.isoformat()] + days
    save(os.path.join(DATA, "index.json"), idx, pretty=True)

    # everything shown in picks/more counts as seen; the rest can resurface
    stamp = today.isoformat()
    for it in picks + more:
        seen[it["id"]] = stamp
    cutoff = (today - dt.timedelta(days=SEEN_DAYS)).isoformat()
    seen = {k: v for k, v in seen.items() if v >= cutoff}
    save(os.path.join(DATA, "seen.json"), seen)
    print(f"  wrote {len(picks)} picks, {len(more)} more, {len(out['shortlist'])} shortlist "
          f"({CALLS['n']} API calls)")


# ------------------------------------------------------------- figures ------
# Key figure per paper, only where the licence allows reuse (Creative Commons
# or public domain) and Europe PMC holds the open full text. Paywalled figures
# are copyrighted, so those papers get no image.

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest"
REUSABLE = re.compile(r"^(cc[- ]?by|cc0|public[- ]domain|pd)", re.I)
FIG_CACHE = {}
HTTP_LAST = {"url": ""}
FIG_STATS = {"epmc_id": 0, "epmc_fig": 0, "arxiv_try": 0, "arxiv_fig": 0}


def http_get(url, accept=None, max_bytes=None):
    req = urllib.request.Request(url, headers={"User-Agent": "journal-feed/1.0 (github.com/drdoombg/Journal-Feed)",
                                               **({"Accept": accept} if accept else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read(max_bytes) if max_bytes else r.read()
            HTTP_LAST["url"] = r.geturl()
            return r.status, r.headers.get("Content-Type", ""), body
    except Exception:
        return None, "", b""
    finally:
        time.sleep(0.15)


def find_pmcid(it):
    if it.get("pmcid"):
        return it["pmcid"] if it["pmcid"].upper().startswith("PMC") else "PMC" + it["pmcid"]
    if not it.get("doi"):
        return ""
    q = urllib.parse.quote(f'DOI:"{it["doi"]}"')
    st, _, body = http_get(f"{EPMC}/search?query={q}&format=json&resultType=lite&pageSize=1")
    if st != 200:
        return ""
    try:
        res = json.loads(body.decode("utf-8")).get("resultList", {}).get("result", [])
        return res[0].get("pmcid", "") if res else ""
    except Exception:
        return ""


def key_figure(pmcid):
    """Graphical abstract if the paper has one, otherwise Figure 1."""
    import xml.etree.ElementTree as ET
    st, _, body = http_get(f"{EPMC}/{pmcid}/fullTextXML")
    if st != 200 or not body:
        return None
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    XL = "{http://www.w3.org/1999/xlink}href"
    figs = root.iter("fig")
    cands = []
    for f in figs:
        g = f.find(".//graphic")
        if g is None or not g.get(XL):
            continue
        label = " ".join((f.findtext("label") or "").split())
        cap = f.find("caption")
        caption = " ".join("".join(cap.itertext()).split()) if cap is not None else ""
        fid = (f.get("id") or "").lower()
        ga = "abs" in fid or "ga" == fid[:2] or "graphical" in caption.lower()[:40]
        cands.append({"href": g.get(XL), "label": label or "Figure", "caption": caption, "ga": ga})
    if not cands:
        return None
    pick = next((c for c in cands if c["ga"]), cands[0])
    href = pick["href"]
    name = href if re.search(r"\.(jpe?g|png|gif)$", href, re.I) else href + ".jpg"
    src = f"https://europepmc.org/articles/{pmcid}/bin/{name}"
    st, ctype, _ = http_get(src, max_bytes=64)
    if st != 200 or not ctype.startswith("image"):
        return None
    return {"src": src, "label": pick["label"], "caption": clip(pick["caption"], 700), "ga": pick["ga"]}


def arxiv_figure(aid):
    """First figure from arXiv's HTML rendering of the paper (exists for most
    papers submitted with LaTeX source since late 2023)."""
    import html as H
    st, _, body = http_get(f"https://arxiv.org/html/{aid}")
    time.sleep(2.5)                                   # be polite to arXiv
    if st != 200 or not body:
        return None
    base = HTTP_LAST["url"].rstrip("/") + "/"
    page = body.decode("utf-8", "replace")
    for m in re.finditer(r"<figure[^>]*class=\"[^\"]*ltx_figure[^\"]*\"[^>]*>(.*?)</figure>", page, re.S):
        inner = m.group(1)
        img = re.search(r"<img[^>]+src=\"([^\"]+)\"", inner)
        if not img:
            continue
        cap = re.search(r"<figcaption[^>]*>(.*?)</figcaption>", inner, re.S)
        caption = H.unescape(re.sub(r"<[^>]+>", " ", cap.group(1))) if cap else ""
        caption = " ".join(caption.split())
        label_m = re.match(r"((?:Figure|Fig\.)\s*\d+)[:.]?\s*", caption)
        label = label_m.group(1) if label_m else "Figure 1"
        if label_m:
            caption = caption[label_m.end():]
        src = urllib.parse.urljoin(base, img.group(1))
        st2, ctype, _ = http_get(src, max_bytes=64)
        if st2 == 200 and ctype.startswith("image"):
            return {"src": src, "label": label, "caption": clip(caption, 700), "ga": False, "via": "arXiv"}
        return None
    return None


def attach_figures(items):
    n_try = n_ok = 0
    for it in items:
        if "fig" in it:
            continue
        if not (it.get("oa") and REUSABLE.match(it.get("license") or "")):
            continue
        if it["id"] in FIG_CACHE:
            fig = FIG_CACHE[it["id"]]
        else:
            n_try += 1
            fig = None
            pmcid = find_pmcid(it) if it.get("d") not in ("Mathematics", "Physics", "Earth and space", "Computer science",
                                                       "Economics", "Business", "Humanities and arts", "Society and law") else ""
            if pmcid:
                FIG_STATS["epmc_id"] += 1
                fig = key_figure(pmcid)
                if fig:
                    FIG_STATS["epmc_fig"] += 1
                    fig["via"] = "Europe PMC"
                    fig["pmcid"] = pmcid
            if not fig and it.get("arxiv"):
                FIG_STATS["arxiv_try"] += 1
                fig = arxiv_figure(it["arxiv"])
                if fig:
                    FIG_STATS["arxiv_fig"] += 1
            if fig:
                lic = it["license"].upper().replace("CC-", "CC ").replace("-", " ")
                first = (it.get("authors") or ["Authors"])[0]
                fig["credit"] = f"{first}{' et al.' if it.get('n_auth', 1) > 1 else ''}, {it['journal']} ({lic})"
            FIG_CACHE[it["id"]] = fig
        if fig:
            it["fig"] = fig
            n_ok += 1
    print(f"  figures: {n_ok} attached from {n_try} open-licence papers checked {FIG_STATS}")


FORCE = {"on": False}
DOMAIN_DAYS = 14
DOMAIN_PER_DAY = 15
DOMAIN_CAP = 45


def update_domain_index(today, everything):
    """data/domains.json: per domain, the best recent papers over the last
    14 days, drawn from everything scanned (not just what made the feed)."""
    path = os.path.join(DATA, "domains.json")
    idx = load(path, {"updated": None, "domains": {}})
    cutoff = (today - dt.timedelta(days=DOMAIN_DAYS)).isoformat()
    by_dom = {}
    for it in sorted(everything.values(), key=lambda x: -x["score"]):
        by_dom.setdefault(it["d"], [])
        if len(by_dom[it["d"]]) < DOMAIN_PER_DAY:
            slim = {k: v for k, v in it.items() if k not in ("score",)}
            slim["abstract"] = clip(slim["abstract"], 900)
            slim["seen_on"] = today.isoformat()
            slim["rank"] = it["score"]
            by_dom[it["d"]].append(slim)
    for d, new in by_dom.items():
        old = [x for x in idx["domains"].get(d, []) if x.get("seen_on", "") >= cutoff]
        ids = {x["id"] for x in new}
        merged = new + [x for x in old if x["id"] not in ids]
        merged.sort(key=lambda x: (x.get("seen_on", ""), x.get("rank", 0)), reverse=True)
        idx["domains"][d] = merged[:DOMAIN_CAP]
    for d in list(idx["domains"]):
        idx["domains"][d] = [x for x in idx["domains"][d] if x.get("seen_on", "") >= cutoff]
    idx["updated"] = today.isoformat()
    save(path, idx)


# ---------------------------------------------------------------- retro -----

def retro(today, cfg, kind):
    """Monthly: papers from 1-3 months ago ranked by citations so far.
       Quarterly: papers from 3-12 months ago. Also reports how many of the
       top-cited papers the daily picks had caught (the ranker's hit rate)."""
    journals = cfg["journals"]
    sources = resolve_sources(journals)
    if kind == "monthly":
        lo, hi, top, per = today - dt.timedelta(days=95), today - dt.timedelta(days=25), 25, 4
    else:
        lo, hi, top, per = today - dt.timedelta(days=370), today - dt.timedelta(days=85), 40, 6

    pool = []
    for j in journals:
        sid = (sources.get(j["issn"]) or {}).get("id")
        if not sid:
            continue
        res = get_json("/works", {
            "filter": f"primary_location.source.id:{sid},from_publication_date:{lo.isoformat()},to_publication_date:{hi.isoformat()},type:article|review",
            "sort": "cited_by_count:desc",
            "per_page": per,
            "select": SELECT,
        })
        for w in (res or {}).get("results", []):
            it = to_item(w, j)
            if is_research(it):
                pool.append(it)

    pool.sort(key=lambda x: -x["cited"])
    best = pick_diverse(pool, top, per_journal=3, per_domain=6)

    shown = set()
    idx = load(os.path.join(DATA, "index.json"), {"days": []})
    for day in idx.get("days", []):
        f = load(os.path.join(DATA, "days", f"{day}.json"), {})
        for p in f.get("picks", []):
            shown.add(p["id"])
    for it in best:
        it["was_picked"] = it["id"] in shown
    caught = sum(1 for it in best if it["was_picked"])

    tag = f"{today.strftime('%Y-%m')}-{kind}"
    out = {"tag": tag, "kind": kind, "date": today.isoformat(),
           "window": [lo.isoformat(), hi.isoformat()],
           "caught": caught, "total": len(best), "items": best}
    save(os.path.join(DATA, "retro", f"{tag}.json"), out)
    ridx = load(os.path.join(DATA, "retro", "index.json"), {"retros": []})
    ridx["retros"] = [tag] + [t for t in ridx.get("retros", []) if t != tag]
    save(os.path.join(DATA, "retro", "index.json"), ridx, pretty=True)
    print(f"  retro {tag}: {len(best)} items, daily picks caught {caught}")


# ----------------------------------------------------------------- main -----

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYY-MM-DD (default: today UTC)")
    ap.add_argument("--retro", choices=["monthly", "quarterly", "auto", "none"], default="auto")
    ap.add_argument("--skip-daily", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-pick today even if today's file exists")
    a = ap.parse_args()
    FORCE["on"] = a.force

    today = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(dt.timezone.utc).date()
    cfg = load(os.path.join(ROOT, "journals.json"), None)
    if not cfg:
        sys.exit("journals.json missing")
    print(f"Journal Feed — {today}  (api key: {'yes' if KEY else 'no'})")

    if not a.skip_daily:
        daily(today, cfg)

    kinds = []
    if a.retro in ("monthly", "quarterly"):
        kinds = [a.retro]
    elif a.retro == "auto" and today.day == 1:
        kinds = ["monthly"] + (["quarterly"] if today.month in (1, 4, 7, 10) else [])
    for k in kinds:
        retro(today, cfg, k)


if __name__ == "__main__":
    main()
