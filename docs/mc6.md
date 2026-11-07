# MC6 · Lexicon

MC6 is LEXICON: one word cloud per source, the operator and every AI agent. A large hero cloud cycles through the
sources, and a strip below keeps one small cloud per source on screen. The rotator names this slide `LEXICON`.

![MC6 Lexicon](screenshots/mc6.png)

## Panels

- Header: `LEXICON // SOURCES`, a subtitle with source and word counts, and a clock.
- Word clouds: the panel title shows how many sources have words, and the most-used shared words.
  - A shared word is one that the operator and at least one agent both use.
- Hero: the top 80 words of one source at a time, or a merged `CONVERGENCE` view of the top 120 words across all
  sources.
  - The hero moves to the next view every 8 seconds. Words morph, disperse and condense between views.
  - In the hero, shared words carry an outline.
- Strip: one small cloud of the top 30 words per source, with the hero's current source highlighted.
  - The known sources, in order, are `OPERATOR`, `CLAUDE`, `CODEX`, `AGY`, `ZCODE` and `OPENCODE`.
  - A source that appears later gets a tile after the known ones, with its name in capitals, and keeps that slot.
- Each cloud is laid out with d3-cloud whenever its words change.

## Data

MC6 uses no `site/lib/queries.js` keys. It reads `GET /api/words` (same origin), ClickHouse `FORMAT JSON`:

```json
{"meta": [], "data": [{"source": "user", "word": "deploy", "n": "412"}], "rows": 1}
```

- `n` is a UInt64 serialized as a string.
- The source `user` is the operator.
- The page polls every `config.json` `refreshSeconds`, 15 seconds by default.

## States

- NO DATA: every known source keeps a tile even when the feed has no rows for it, with an explicit `NO FEED` state.
- STALE:
  - A feed that fails keeps its last good clouds and shows the stale indicator.
  - The last good clouds survive a page reload.
  - The subtitle reads `STALE <age>`, then `STALE since <time>` after 5 minutes, and the panel title reads `STALE`.
- Pending: with no data ever and the feed down, the panel stays `pending`.
- Empty: a successful poll with no rows records state `empty`.
- Idle and Unavailable: not used on MC6. MC6 never shows stand-in words.
