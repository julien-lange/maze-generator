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

- **`pack.json`** — 40 mazes generated ahead of time, in eight tiers of five.
  The grid holds at one size for a whole tier before stepping up, so he gets
  five goes at a size before it grows:

      6x4 -> 8x5 -> 10x7 -> 12x8 -> 14x10 -> 16x11 -> 18x13 -> 20x14
       1*    2*     2*      3*      3*       4*       4*       5*

  Within a tier the mazes get harder while the grid stays put; stars mark the
  tier. Generating them in Go means they can be quality-controlled: `Pick` keeps
  the highest-scoring of twelve candidates, so no maze has its answer running
  straight from corner to corner. `-hold` sets the tier length.
- **`maze.wasm`** — the same Go generator compiled with
  `GOOS=js GOARCH=wasm`, for endless mazes sized to fill whatever screen it is
  on, the cells shrinking a little with each win. The ∞ button switches to it
  and back, and it takes over by itself once the pack is finished. The button
  appears as soon as the wasm has loaded, so its presence doubles as a sign the
  wasm is working. It is optional: if the wasm fails to load, the pack still
  plays and the button never appears.

  To jump ahead in the pack while testing:

      localStorage.setItem('maze.progress.v1',
        JSON.stringify({level: 39})); location.reload()

Drawing is cell-by-cell rather than freehand. Walls block the finger, a fast
flick is filled back in as a legal walk, and sliding back over the trail rewinds
it — so retreating out of a dead end is the same gesture as going in.

### Which maze is this?

Packs alternate between the two generators, because they fail differently and a
pack of only one kind gets samey. Both appear in every tier. On the same 20x14
grid:

| | solution | junctions | feels like |
|---|---|---|---|
| `prim` | short (37 steps) | many (24) | constant forks, stubby dead ends |
| `dfs` | long (159 steps) | few (20) | one snaking corridor, little to decide |

Step count alone therefore says nothing useful across the two. The line under
the board gives the size, which generator carved it, and the measurement:

    #36/40 · 20×14 · prim · 37 steps · 24 junctions · score 109

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
    make pack HOLD=8              # eight goes at each size instead of five
    make pack PACK=60 SEED=7      # more mazes, different set

`HOLD` and `PACK` together decide how gently the grid grows: 40 mazes at
`HOLD=5` is eight sizes, at `HOLD=10` just four.

## Publishing to GitHub Pages

Push, then in **Settings → Pages** set the source to **main / docs**. Nothing
else is needed: Pages serves `.wasm` with the right `application/wasm` MIME
type, and `.nojekyll` keeps Jekyll's hands off the directory.

The page installs to a phone home screen ("Add to Home Screen") and works with
no signal afterwards, because `sw.js` caches everything on first visit. **That
cache is why you must bump `VERSION` in `docs/sw.js` whenever you republish a
new pack or a new wasm build** — otherwise phones will keep serving the old one.
