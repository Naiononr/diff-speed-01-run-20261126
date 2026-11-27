[![make.fun bounty](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![make.fun rank](https://make.fun/badge/diff-speed-01-run-20261126/Naiononr/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![make.fun reward](https://make.fun/badge/diff-speed-01-run-20261126/Naiononr/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

# diff-speed-01-run-20261126

A faster drop-in for [make.fun](https://make.fun/bounty/diff-speed-01-run-20261126)'s own
`makefun-diff` 1.0.0, built for make.fun's "Diff two texts faster, 27 November 2026" bounty.
For every case's input `{ old, new }`, `run(input)` returns exactly the patch
`makefun-diff` 1.0.0 returns — byte for byte — but faster.

## How it works

- Lines are interned once per case to small integer ids through a `Map` keyed by
  the line string itself, so id equality *is* string equality (exact, no hashing)
  and every later comparison is one integer compare on a typed array.
- The common prefix is kept, then the common suffix; between them Myers's greedy
  search runs with the reference's exact rules (furthest-reaching path per
  diagonal, deletion preferred over insertion on ties, no edge-diagonal pruning,
  every run of equal lines followed as far as it goes). The search keeps one
  furthest-reaching old index per diagonal per `d` in a trace of `Int32Array`
  rows, and the backtrack replays the reference's candidate choice from the
  trace, so the reconstructed script is the reference's script.
- The patch is rendered straight from the original texts' line spans, with the
  same hunks (up to 3 kept lines of context, runs at most 6 kept lines apart
  sharing a hunk) and the same `%` marker for a line that ends its text with
  no newline.

## Layout

- `solve.js` — the entry: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the program the harness runs: reads `/input/cases.json`, answers
  each case with `run`, writes `/output/answers.json`.

## Verification

On the kit's practice set (4 cases, ~21k–31k lines per text) every answer is
byte-identical to the house baseline's, and the total run takes ~0.45s against
the baseline's ~1.32s on this machine (~3x faster). A 4,581-case fuzz battery
(random small texts, mutations, CRLF, bare endings, moved blocks) shows zero
mismatches against `makefun-diff` 1.0.0.

## License

MIT — see [LICENSE](LICENSE).
