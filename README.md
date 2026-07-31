# maze

Generates mazes, and plays them in a browser with a finger or a mouse.

The maze itself is a graph (`maze.go`). Everything else is a pass over that
graph that only ever asks which walls are open: `print.go` turns one into
characters for A4, `pack.go` turns one into JSON for the browser, and
`solve.go` walks it.

## Printing one

    go run . -n 20 -m 15            # 20 rows, 15 columns, to stdout
    go run . -unicode -cw 3         # box-drawing characters
    go run . -seed 12345            # replay a maze you liked

## The browser player

`docs/` is a self-contained static site: no build step, no framework, no
network calls beyond its own files.

    make            # rebuild docs/pack.json and docs/maze.wasm
    make serve      # then open http://localhost:8731/

It gets its mazes from two places, and cannot tell them apart:

- **`pack.json`** — 40 mazes generated ahead of time, growing from 6x4 to
  19x13, sorted so they get harder, and starred one to five. Generating them in
  Go means they can be quality-controlled: `Pick` keeps the highest-scoring of
  twelve candidates, so no maze has its answer running straight from corner to
  corner.
- **`maze.wasm`** — the same Go generator compiled with
  `GOOS=js GOARCH=wasm`, for endless mazes sized to fill whatever screen it is
  on. The ∞ button in the corner turns it on, and it takes over automatically
  once the pack is finished. It is optional: if the wasm fails to load, the
  pack still plays.

Drawing is cell-by-cell rather than freehand. Walls block the finger, a fast
flick is filled back in as a legal walk, and sliding back over the trail rewinds
it — so retreating out of a dead end is the same gesture as going in.

### Which maze is this?

Packs alternate between the two generators, because they fail differently and a
pack of only one kind gets samey. On the same 19x13 grid:

| | solution | junctions | feels like |
|---|---|---|---|
| `prim` | short (41 steps) | many (28) | constant forks, stubby dead ends |
| `dfs` | long (139 steps) | few (14) | one snaking corridor, little to decide |

Step count alone therefore says nothing useful across the two. The line under
the board gives the size, which generator carved it, and the measurement:

    #35/40 · 19×13 · prim · 41 steps · 28 junctions · score 125

A **junction** is a cell on the solution with three or more ways out — a place
he has to choose, and can choose wrongly. **Score** is `steps + 3 × junctions`
(`Score` in `pack.go`): wrong turns are weighted heavily because those are what
actually defeat a small child, not the walking. The pack is sorted by score and
starred by quintile, so the stars always climb even though the two generators
produce such different-looking mazes.

Watch which scores he starts failing at, and set the pack size accordingly.

### Changing the shape

Cells come out around 26px on a phone at the default 20x14, which is tight for
a small finger. Fewer columns makes them bigger:

    make pack ROWS=14 COLS=10
    make pack PACK=60 SEED=7      # more mazes, different set

## Publishing to GitHub Pages

Push, then in **Settings → Pages** set the source to **main / docs**. Nothing
else is needed: Pages serves `.wasm` with the right `application/wasm` MIME
type, and `.nojekyll` keeps Jekyll's hands off the directory.

The page installs to a phone home screen ("Add to Home Screen") and works with
no signal afterwards, because `sw.js` caches everything on first visit. **That
cache is why you must bump `VERSION` in `docs/sw.js` whenever you republish a
new pack or a new wasm build** — otherwise phones will keep serving the old one.
