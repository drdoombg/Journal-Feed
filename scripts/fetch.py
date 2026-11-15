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
    "primary_location", "best_oa_location",
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
        "date": w.get("publication_date"),
        "type": w.get("type"),
        "review": bool(w.get("type") == "review" or j.get("review")),
        "cited": w.get("cited_by_count") or 0,
        "authors": auths[:4],
        "n_auth": len(auths),
        "abstract": clip(abstract_from_index(w.get("abstract_inverted_index")), 1800),
        "oa": bool(oa.get("is_oa")),
        "oa_url": best.get("pdf_url") or best.get("landing_page_url") or oa.get("oa_url") or "",
        "topic": topic or "",
    }


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

    pool, n_raw = [], 0
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
            if it["id"] in seen or not is_research(it):
                continue
            it["score"] = score(it, bias)
            pool.append(it)

    # dedupe (a paper can be listed under two sources)
    uniq = {}
    for it in pool:
        if it["id"] not in uniq or uniq[it["id"]]["score"] < it["score"]:
            uniq[it["id"]] = it
    pool = sorted(uniq.values(), key=lambda x: -x["score"])
    print(f"  {n_raw} raw works, {len(pool)} new research items")

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
    out = {
        "date": today.isoformat(),
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats": {"raw": n_raw, "new": len(pool), "calls": CALLS["n"], "journals": len(journals)},
        "picks": picks,
        "more": more,
        "shortlist": [by_id[i] for i in shortlist_ids if i in by_id],
    }

    day_path = os.path.join(DATA, "days", f"{today.isoformat()}.json")
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
    a = ap.parse_args()

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
