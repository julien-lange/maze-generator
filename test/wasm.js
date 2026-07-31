'use strict';

// Loads docs/maze.wasm the way the page does and checks that what comes back is
// a valid, solvable, walkable maze in the same wire format as the pack — so the
// two halves of the app cannot drift apart.

const fs = require('fs');
const path = require('path');
const { DOCS, loadLogic, degree, results } = require('./harness');

require(path.join(DOCS, 'wasm_exec.js'));   // defines globalThis.Go

const L = loadLogic();
const r = results('WASM CHECKS');

const go = new Go();
WebAssembly.instantiate(fs.readFileSync(path.join(DOCS, 'maze.wasm')), go.importObject).then((res) => {
  go.run(res.instance);   // returns at the first block; the export is set before that

  if (typeof globalThis.mazeGenerate !== 'function') {
    console.log('FAIL: mazeGenerate was not exported');
    process.exit(1);
  }

  const t0 = Date.now();
  const shapes = [[6, 5], [15, 10], [20, 14], [40, 30]];

  for (const [rows, cols] of shapes) {
    for (let n = 0; n < 5; n++) {
      const d = JSON.parse(globalThis.mazeGenerate(rows, cols, 1000 + n, 12));
      if (d.error) { r.fail(d.error); continue; }
      const m = new L.Maze(d);
      L.set(m);

      let open = 0;
      for (const v of m.east) open += v;
      for (const v of m.south) open += v;
      if (m.rows !== rows || m.cols !== cols) r.fail(`asked for ${rows}x${cols}, got ${m.rows}x${m.cols}`);
      if (open !== rows * cols - 1) r.fail(`${rows}x${cols} is not a spanning tree`);
      if (!m.solution.length) r.fail(`${rows}x${cols} has no solution`);
      if (!m.startMark || m.startMark === m.endMark) r.fail(`${rows}x${cols} has bad animals`);

      // The measurements must be right here too, not only in the pack.
      if (d.steps !== m.solution.length) r.fail(`${rows}x${cols}: steps disagree with the solution`);
      const junctions = m.solution.filter(([row, col]) => degree(m, row, col) >= 3).length;
      if (d.junctions !== junctions) r.fail(`${rows}x${cols}: says ${d.junctions} junctions, counted ${junctions}`);
      if (d.score !== d.steps + 3 * d.junctions) r.fail(`${rows}x${cols}: score is not steps + 3*junctions`);
      if (!['prim', 'dfs'].includes(d.algo)) r.fail(`${rows}x${cols}: unknown algorithm "${d.algo}"`);

      L.reset();
      L.advance(m.start[0], m.start[1]);
      for (const [row, col] of m.solution) L.walkTowards(row, col);
      if (!L.state().won) r.fail(`${rows}x${cols}: the solution is not walkable`);
    }
  }

  // Both generators must actually turn up over a run of seeds.
  const algos = new Set();
  for (let s = 0; s < 20; s++) algos.add(JSON.parse(globalThis.mazeGenerate(12, 9, 500 + s, 4)).algo);
  if (algos.size !== 2) r.fail(`endless mode only ever used: ${[...algos].join(', ')}`);

  // Determinism: the same seed must give the same maze.
  const a = globalThis.mazeGenerate(15, 10, 42, 12);
  if (a !== globalThis.mazeGenerate(15, 10, 42, 12)) r.fail('the same seed gave different mazes');
  if (a === globalThis.mazeGenerate(15, 10, 43, 12)) r.fail('different seeds gave the same maze');

  const t1 = Date.now();
  const big = JSON.parse(globalThis.mazeGenerate(40, 30, 7, 12));

  r.done(
    `20 mazes in ${t1 - t0}ms; a 40x30 best-of-12 takes ${Date.now() - t1}ms`,
    `largest: ${big.steps} steps, ${big.junctions} junctions, ${big.startMark}->${big.endMark}`,
  );
});
