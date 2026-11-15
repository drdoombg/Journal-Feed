# Journal Feed

A daily feed of the best new papers from ~95 top journals across 15 domains,
built to replace doomscrolling.

**Open it:** https://drdoombg.github.io/Journal-Feed/ (add to home screen on your phone)

## How it works

| Layer | Runs | Cost |
|---|---|---|
| `scripts/fetch.py` via GitHub Actions: pulls new papers from OpenAlex, filters non-research items, scores, diversifies | daily 05:20 UTC | free |
| Monthly / quarterly retro: last 1–3 and 3–12 months ranked by citations, plus how many the daily picks caught | 1st of month / quarter | free |
| Claude commentary: picks the final 10 from a 60-paper shortlist and writes why each matters (`COMMENTARY.md`) | daily, after the Action | Claude plan |
| Deep pool: infinite random high-quality papers fetched in the browser once you're caught up | on scroll | free |

Votes (👍/👎) sync to `data/votes.json` and tilt both the rules ranking and Claude's picks.

## Setup

1. **Pages:** Settings → Pages → Deploy from branch → `main` / root.
2. **OpenAlex key (free, recommended):** make an account at openalex.org, copy the key from
   openalex.org/settings/api, add it as repo secret `OPENALEX_API_KEY`
   (Settings → Secrets and variables → Actions).
3. **Vote sync (optional):** create a fine-grained GitHub token with Contents: read & write on this
   repo only, and paste it in the app's ⚙ Settings.

## Files

- `journals.json` — the journal list, domains, tiers. Edit to add or remove journals.
- `data/days/` — one file per day. `data/latest.json` is today.
- `data/commentary/` — Claude's daily picks and notes.
- `data/retro/` — monthly and quarterly retrospectives.
