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

## Output schema

```json
{
  "date": "YYYY-MM-DD",
  "order": ["W123", "W456", "... exactly 10 ids from shortlist, best first"],
  "notes": {
    "W123": "Why it matters, in 25–45 words."
  },
  "thread": "Optional: up to 80 words linking two or more of today's picks across domains. Use null if no connection is real.",
  "taste": "One line on how votes tilted today's picks, or null."
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
- The file parses as JSON.
