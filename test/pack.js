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
  //    A finger goes back the way it came, so the walk is fed the trail in
  //    reverse and must give up one cell for each.
  if (sol.length > 3) {
    L.reset();
    L.advance(m.start[0], m.start[1]);
    for (const [row, col] of sol) L.walkTowards(row, col);
    for (let k = sol.length - 1; k >= 1; k--) L.walkTowards(sol[k][0], sol[k][1]);
    st = L.state();
    if (st.path.length !== 2) r.fail(`#${i}: rewind left ${st.path.length} cells, want 2`);
    if (st.won) r.fail(`#${i}: still flagged as won after retreating`);
  }

  // 7. A fingertip straying over a wall onto a corridor drawn long ago must
  //    cost nothing. In a perfect maze two cells that touch without being
  //    neighbours on the trail have a wall between them, so this is the pair
  //    to aim at: it is the stray that used to unwind a whole run at once.
  const stray = [];
  for (let a = 0; a < sol.length && !stray.length; a++) {
    for (let b = a + 2; b < sol.length; b++) {
      if (Math.abs(sol[a][0] - sol[b][0]) + Math.abs(sol[a][1] - sol[b][1]) === 1) {
        stray.push(a, b);
        break;
      }
    }
  }
  if (stray.length) {
    const [a, b] = stray;
    L.reset();
    L.advance(m.start[0], m.start[1]);
    for (let k = 1; k <= b; k++) L.walkTowards(sol[k][0], sol[k][1]);
    const was = L.state().path.length;
    L.walkTowards(sol[a][0], sol[a][1]);
    st = L.state();
    if (st.path.length !== was) {
      r.fail(`#${i}: straying onto step ${a} from step ${b} took the trail from ${was} to ${st.path.length}`);
    }
  }
}

// 8. The string. Pulled roughly the right way for each step of the solution,
//    up to 25 degrees off, the head follows it exactly; a long pull along
//    the first corridor never crosses a wall; and a tug back short of a full
//    step gives nothing up.
for (const [i, d] of pack.mazes.entries()) {
  const m = new L.Maze(d);
  L.set(m);
  const sol = m.solution;
  const STEP = 20;
  let seed = i * 7919 + 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  L.reset();
  L.advance(m.start[0], m.start[1]);
  // Aim at whichever cell of the solution comes next after the head, since
  // the head may have run on ahead of the last pull.
  for (let guard = 0; guard < sol.length * 8; guard++) {
    const p = L.state().path;
    if (p.length >= sol.length || String(p.at(-1)) !== String(sol[p.length - 1])) break;
    const head = p.at(-1), next = sol[p.length];
    const a = Math.atan2(next[0] - head[0], next[1] - head[1]) + (rand() - 0.5) * (50 * Math.PI / 180);
    L.slide(Math.cos(a) * STEP * 0.25, Math.sin(a) * STEP * 0.25, STEP);
  }
  let st = L.state();
  if (JSON.stringify(st.path) !== JSON.stringify(sol)) {
    r.fail(`#${i}: a rough pull along the solution drew ${st.path.length} cells, not the ${sol.length} of the solution`);
  }
  if (!st.won) r.fail(`#${i}: a rough pull along the solution did not win`);

  L.reset();
  L.advance(m.start[0], m.start[1]);
  L.slide(STEP * 40, STEP * 40, STEP);
  st = L.state();
  for (let k = 1; k < st.path.length; k++) {
    if (!m.linked(st.path[k - 1][0], st.path[k - 1][1], st.path[k][0], st.path[k][1])) {
      r.fail(`#${i}: a long pull tunnelled through a wall at step ${k}`);
    }
  }

  if (sol.length > 3) {
    L.reset();
    L.advance(m.start[0], m.start[1]);
    for (let k = 1; k <= 3; k++) L.advance(sol[k][0], sol[k][1]);
    const back = [sol[2][1] - sol[3][1], sol[2][0] - sol[3][0]];
    L.slide(back[0] * STEP * 0.9, back[1] * STEP * 0.9, STEP);
    if (L.state().path.length !== 4) r.fail(`#${i}: a tug back of nine-tenths of a step gave up a cell`);
  }
}

// 9. A pull never turns a corner the finger has not turned: dragged straight
//    on at a bend, the head stops there instead of heading off round it.
for (const [i, d] of pack.mazes.entries()) {
  const m = new L.Maze(d);
  L.set(m);
  const sol = m.solution;
  const k = sol.findIndex((cur, j) => j > 0 && j < sol.length - 1 &&
    (sol[j + 1][0] - cur[0] !== cur[0] - sol[j - 1][0] || sol[j + 1][1] - cur[1] !== cur[1] - sol[j - 1][1]));
  if (k < 0) continue;
  const dr = sol[k][0] - sol[k - 1][0], dc = sol[k][1] - sol[k - 1][1];
  if (m.linked(sol[k][0], sol[k][1], sol[k][0] + dr, sol[k][1] + dc)) continue;   // a fork, not a bend
  L.reset();
  for (let j = 0; j <= k; j++) L.advance(sol[j][0], sol[j][1]);
  for (let n = 0; n < 12; n++) L.slide(dc * 5, dr * 5, 20);
  const p = L.state().path;
  if (p.length !== k + 1) r.fail(`#${i}: a straight pull at the bend after step ${k} went round it to ${p.at(-1)}`);
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
