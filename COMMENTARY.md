# Daily commentary — instructions for Claude

The GitHub Action writes `data/latest.json` every morning. It contains a
rules-ranked `shortlist` of ~60 new papers from top journals. Your job is the
part rules can't do: judgement.

## Steps

1. Read `data/latest.json`. Note its `date`.
2. If `data/commentary/<date>.json` already exists, stop: today is done.
3. Read `data/votes.json` if it exists. It maps paper id to
   `{v: 1 | -1, d: domain, issn}`. Summarise which domains and journals the
   reader has up-voted or down-voted, and let that tilt your choices. Taste is
   a tilt, not a filter: one great paper from a down-voted domain still beats
   a mediocre one from a favoured domain.
4. From `shortlist`, choose the 10 papers most worth this reader's attention.
5. Write `data/commentary/<date>.json` (schema below), validate it, commit with
   message `commentary: <date>` and push to `main`. If the push is rejected,
   run `git pull --rebase` and push again.

## What to choose

The reader is a medically trained, cross-domain science communicator who
builds simulations and wants a constant injection of genuinely important ideas
across all fields. Favour, in roughly this order:

- **Conceptual advances.** A result that changes how a problem is framed, not
  just a better number on an existing benchmark.
- **New capability.** A method, tool or dataset that will make other work
  possible. Methods papers are often the real news.
- **Field-defining reviews.** A review from Annual Reviews, Reviews of Modern
  Physics, Chemical Reviews or similar that maps a whole area. Include at most
  two a day.
- **Cross-domain structure.** A mechanism or mathematical idea that clearly
  transfers between fields.
- **Clinical or societal consequence**, where it's backed by a strong design
  (large randomised trial, natural experiment) rather than an association.

Be sceptical of: superlatives in abstracts, small samples with big claims,
"first ever" framing, incremental papers in famous journals. Spread across at
least 5 domains. Ignore anything that's plainly not research (news, comment,
corrections) that slipped through.

## Fundamentals (second job)

`fundamentals` in `data/latest.json` lists ~25 papers that rules nominated as
possibly foundational. Rules only see words like "theory" and "universal", so
most nominees are false positives. Choose **0–5** that genuinely change the
foundations a field rests on: a new principle, an overturned assumption, a
unification, a proof that settles a framing question, a mechanism that
explains *why* rather than *what*. Expansion (applying a known idea somewhere
new, or a better number) does not count, however good. Choosing zero on a
thin day is correct.

For each chosen paper, write a note in the form
`Shifts: <the assumption or framing before> → <what it is now>. <one sentence on what this changes at the foundation>.`
Keep it to 25–50 words.

## Foundation card (third job)

Take today's picks (and fundamentals, if useful) and work down to the
foundation: what deeper principle are two or more of them instances of? Write
it so it would change how the reader thinks about all of them, and beyond.

- `title`: the principle in at most 8 words.
- `principle`: 80–150 words. State the principle, show how each paper it was
  built from is a case of it, and say where else it applies.
- `built_from`: 2–4 paper ids from today's file that are instances of it.
- `rests_on`: 1–3 canonical earlier works the principle rests on, written as
  `Author (Year). Title`. **Only works you are certain exist**: landmark
  papers or books, not obscure ones. Never invent a reference. The app turns
  each into a Google Scholar search, so no URLs.
- `question`: one open question at the frontier of this principle.

If no honest connection exists today, set `foundation` to null rather than
forcing one.

## Consolidation and figures (for each of the 10 picks)

- `consolidation[id]`: the paper in four short parts, each at most 25 words:
  `question` (what they asked), `approach` (how), `finding` (the result, with
  numbers where the abstract gives them), `implication` (what it changes).
  Work only from the title, abstract and figure caption.
- `figure_notes[id]`: only for picks that have a `fig` object. 30–60 words
  walking the reader through what the figure shows and how to read it, based
  on its caption. This is the paper explained through its key visual.

## Output schema

```json
{
  "date": "YYYY-MM-DD",
  "order": ["W123", "W456", "... exactly 10 ids from shortlist, best first"],
  "notes": {
    "W123": "Why it matters, in 25–45 words."
  },
  "thread": "Optional: up to 80 words linking two or more of today's picks across domains. Use null if no connection is real.",
  "taste": "One line on how votes tilted today's picks, or null.",
  "fundamentals": {
    "order": ["0 to 5 ids from the fundamentals list"],
    "notes": {"W789": "Shifts: ... → .... What it changes at the foundation."}
  },
  "foundation": {
    "title": "...",
    "principle": "...",
    "built_from": ["W123", "W456"],
    "rests_on": ["Author (Year). Title"],
    "question": "..."
  },
  "consolidation": {
    "W123": {"question": "...", "approach": "...", "finding": "...", "implication": "..."}
  },
  "figure_notes": {"W123": "How to read the key figure."}
}
```

## How to write a note

- Say what is **new**, then **why it matters**, then one honest caveat if
  there is one.
- Never restate the title. Assume the reader sees the title above your note.
- Be concrete: name the mechanism, the effect size or the design.
- Plain language, no hype words (breakthrough, revolutionary, game-changing).
- Work only from the title, abstract and metadata. Don't invent details.

## Validation before committing

- `order` has exactly 10 ids, all present in `shortlist`, no duplicates.
- Every id in `order` has a note.
- `fundamentals.order` has 0–5 ids, all present in the `fundamentals` list, each with a note.
- `foundation` is null, or its `built_from` ids all appear in today's file.
- Every id in `order` has a `consolidation`; `figure_notes` only for picks with `fig`.
- The file parses as JSON.
