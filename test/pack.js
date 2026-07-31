'use strict';

// Checks docs/pack.json: that every maze decodes to a real maze, that the
// numbers Go measured match it, that the tiers are the shape BuildPack claims,
// and that a finger can actually get through each one.
//
// HOLD must match the -hold the pack was built with; the Makefile passes it.

const { readPack, loadLogic, degree, results } = require('./harness');

const L = loadLogic();
const pack = readPack();
const r = results('PACK CHECKS');
const HOLD = Number(process.env.HOLD || 5);

for (const [i, d] of pack.mazes.entries()) {
  const m = new L.Maze(d);
  L.set(m);

  // 1. Both generators carve a spanning tree, so a correctly decoded maze has
  //    exactly one fewer passage than it has cells.
  let open = 0;
  for (const v of m.east) open += v;
  for (const v of m.south) open += v;
  if (open !== m.rows * m.cols - 1) {
    r.fail(`#${i}: ${open} passages for ${m.rows * m.cols} cells (want ${m.rows * m.cols - 1})`);
  }

  // 2. The shipped solution must be a legal walk from start to end.
  const sol = m.solution;
  if (String(sol[0]) !== String(m.start)) r.fail(`#${i}: solution starts at ${sol[0]}, not ${m.start}`);
  if (String(sol.at(-1)) !== String(m.end)) r.fail(`#${i}: solution ends at ${sol.at(-1)}, not ${m.end}`);
  for (let k = 1; k < sol.length; k++) {
    if (!m.linked(sol[k - 1][0], sol[k - 1][1], sol[k][0], sol[k][1])) {
      r.fail(`#${i}: solution step ${k} crosses a wall`);
    }
  }

  // 3. The measurements shown under the board must match the maze.
  if (!['prim', 'dfs'].includes(d.algo)) r.fail(`#${i}: unknown algorithm "${d.algo}"`);
  if (d.steps !== sol.length) r.fail(`#${i}: says ${d.steps} steps, solution has ${sol.length}`);
  const junctions = sol.filter(([row, col]) => degree(m, row, col) >= 3).length;
  if (d.junctions !== junctions) r.fail(`#${i}: says ${d.junctions} junctions, counted ${junctions}`);
  if (d.score !== d.steps + 3 * d.junctions) r.fail(`#${i}: score ${d.score} is not steps + 3*junctions`);
  if (d.stars < 1 || d.stars > 5) r.fail(`#${i}: ${d.stars} stars`);

  // 4. Dragging along the solution must reproduce it exactly, and win.
  L.reset();
  L.advance(m.start[0], m.start[1]);
  for (const [row, col] of sol) L.walkTowards(row, col);
  let st = L.state();
  if (JSON.stringify(st.path) !== JSON.stringify(sol)) r.fail(`#${i}: traced path differs from the solution`);
  if (!st.won) r.fail(`#${i}: reaching the end did not register a win`);

  // 5. A fast flick straight at the far corner must never tunnel through a wall.
  L.reset();
  L.advance(m.start[0], m.start[1]);
  L.walkTowards(m.rows - 1, m.cols - 1);
  st = L.state();
  for (let k = 1; k < st.path.length; k++) {
    if (!m.linked(st.path[k - 1][0], st.path[k - 1][1], st.path[k][0], st.path[k][1])) {
      r.fail(`#${i}: a flick tunnelled through a wall at step ${k}`);
    }
  }

  // 6. Retreating back over the trail rewinds it rather than doubling it up.
  if (sol.length > 3) {
    L.reset();
    L.advance(m.start[0], m.start[1]);
    for (const [row, col] of sol) L.walkTowards(row, col);
    L.walkTowards(sol[1][0], sol[1][1]);
    st = L.state();
    if (st.path.length !== 2) r.fail(`#${i}: rewind left ${st.path.length} cells, want 2`);
    if (st.won) r.fail(`#${i}: still flagged as won after retreating`);
  }
}

// 7. The pack must be a mix of both generators.
const byAlgo = {};
for (const m of pack.mazes) byAlgo[m.algo] = (byAlgo[m.algo] || 0) + 1;
for (const name of ['prim', 'dfs']) {
  if (!byAlgo[name]) r.fail(`the pack contains no ${name} mazes at all`);
}

// 8. The grid must never shrink, and stars must never go backwards.
for (let i = 1; i < pack.mazes.length; i++) {
  const a = pack.mazes[i - 1];
  const b = pack.mazes[i];
  if (b.rows < a.rows || b.cols < a.cols) {
    r.fail(`grid shrinks at #${i}: ${a.rows}x${a.cols} -> ${b.rows}x${b.cols}`);
  }
  if (b.stars < a.stars) r.fail(`stars go backwards at #${i}`);
  if (i % HOLD !== 0) {   // inside a tier the size is fixed and the score climbs
    if (b.rows !== a.rows || b.cols !== a.cols) r.fail(`size changed inside a tier at #${i}`);
    if (b.score < a.score) r.fail(`tier not sorted by score at #${i}`);
  }
}

// 9. Every tier must be a real plateau: one size, both generators, HOLD long.
const tiers = [];
for (let i = 0; i < pack.mazes.length; i += HOLD) {
  const t = pack.mazes.slice(i, i + HOLD);
  if (new Set(t.map((m) => `${m.rows}x${m.cols}`)).size !== 1) r.fail(`tier at #${i} is not all one size`);
  if (i + HOLD <= pack.mazes.length && t.length !== HOLD) r.fail(`tier at #${i} has ${t.length} mazes`);
  if (t.length > 1 && new Set(t.map((m) => m.algo)).size !== 2) r.fail(`tier at #${i} uses only one generator`);
  tiers.push(`${t[0].rows}x${t[0].cols}(${t[0].stars}*)`);
}

r.done(
  `${pack.mazes.length} mazes in ${tiers.length} tiers of ${HOLD}`,
  `tiers: ${tiers.join(' -> ')}`,
  `mix: ${Object.entries(byAlgo).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  `scores: ${pack.mazes.map((m) => m.score).join(' ')}`,
);
