'use strict';

// Runs docs/app.js for real against a stub DOM: loads the pack, lays out and
// draws the canvases, then fires genuine pointer events and checks what got
// drawn. This is the suite that catches anything which only breaks once the
// drawing and pointer code actually runs.

const fs = require('fs');
const path = require('path');
const { DOCS, readPack, loadLogic, results } = require('./harness');

const pack = readPack();
const r = results('PLAYER CHECKS');
const calls = {};
let reloads = 0;

function ctx2d() {
  const rec = (name) => (...a) => { calls[name] = (calls[name] || 0) + 1; return a; };
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 0, lineCap: '', lineJoin: '',
    textAlign: '', textBaseline: '',
    setTransform: rec('setTransform'), clearRect: rec('clearRect'), fillRect: rec('fillRect'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    stroke: rec('stroke'), fill: rec('fill'), setLineDash: rec('setLineDash'),
    ellipse: rec('ellipse'),
  };
  // The trail is a rainbow, painted with one gradient per step; keep every
  // colour stop so the checks below can tell a rainbow from a single colour.
  ctx.createLinearGradient = (...a) => {
    calls.createLinearGradient = (calls.createLinearGradient || 0) + 1;
    return { args: a, addColorStop: (o, c) => (calls.colourStops = calls.colourStops || new Set()).add(c) };
  };
  // The head of the trail is a disc, and the first arc of a redraw is it, so
  // keeping the arguments is what lets the drag checks below say where the
  // head ended up — and an empty list says the trail never moved.
  ctx.arc = (...a) => {
    calls.arc = (calls.arc || 0) + 1;
    (calls.arcs = calls.arcs || []).push(a);
    return a;
  };
  // Emoji are drawn with fillText, and the canvas applies the fill's alpha to
  // colour glyphs, so record what the fill was at the moment each one was drawn.
  ctx.fillText = (...a) => {
    calls.fillText = (calls.fillText || 0) + 1;
    (calls.fillTextStyles = calls.fillTextStyles || []).push(String(ctx.fillStyle));
    return a;
  };
  return ctx;
}

function el(id) {
  const handlers = {};
  return {
    id, hidden: true, textContent: '', style: {}, width: 0, height: 0,
    _handlers: handlers, _attrs: {},
    getContext: () => (el._ctx[id] = el._ctx[id] || ctx2d()),
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => true,
    appendChild: () => {}, remove: () => {},
    get clientWidth() { return id === 'stage' ? STAGE_W : 0; },
    get clientHeight() { return id === 'stage' ? STAGE_H : 0; },
  };
}
el._ctx = {};

const STAGE_W = 390;   // a phone, roughly
const STAGE_H = 560;
const SIDE = 24;       // the strip kept clear of Android's back gesture; matchMedia says touch

const nodes = {};
const get = (id) => (nodes[id] = nodes[id] || el(id));
const click = (id) => (get(id)._handlers.click || []).forEach((h) => h());

// defineProperty rather than assignment: recent Node versions define some of
// these (navigator, for one) as getter-only globals, which a plain assignment
// silently drops in sloppy mode and throws over in strict.
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

define('window', globalThis);
// The page listens on window for the back swipe (popstate) and for being put
// away (pagehide), and pushes a history entry to catch the swipe.
const winHandlers = {};
define('addEventListener', (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); });
const fireWin = (t) => (winHandlers[t] || []).forEach((h) => h({}));
const pushed = [];
define('history', { pushState: (st) => { pushed.push(st); } });
define('document', { getElementById: get, createElement: () => el('span'), addEventListener: () => {} });
define('location', { protocol: 'file:', reload: () => { reloads++; } });   // no worker registered
define('navigator', {});                            // no serviceWorker in it, so none is registered
define('matchMedia', () => ({ matches: true }));    // reduced motion: suppress confetti
define('ResizeObserver', class { observe() {} });
define('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
define('devicePixelRatio', 2);
define('localStorage', {
  _v: {},
  getItem(k) { return this._v[k] || null; },
  setItem(k, v) { this._v[k] = v; },
  removeItem(k) { delete this._v[k]; },
});
define('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve(pack) }));

// A generator that is ready and working, so the endless-button checks below
// test a real decision rather than just the absence of wasm.
define('Go', function Go() {
  this.importObject = {};
  this.run = () => { globalThis.mazeGenerate = () => JSON.stringify(pack.mazes[0]); };
});
define('WebAssembly', { instantiateStreaming: () => Promise.resolve({ instance: {} }) });

process.on('unhandledRejection', (e) => { console.log('UNHANDLED:', e); process.exit(1); });
require(path.join(DOCS, 'app.js'));

// app.js loads the pack through a promise, so let the microtasks drain first.
setTimeout(() => {
  const ink = get('ink');
  const m = pack.mazes[0];
  const n = pack.mazes.length;

  // 1. Laid out, scaled for the display, and drawn.
  if (!ink.width || !ink.height) r.fail('canvas was never sized');
  if (ink.width !== Math.round(parseFloat(ink.style.width) * 2)) r.fail('canvas ignores devicePixelRatio');
  const wantSegs = m.rows * (m.cols + 1) + m.cols * (m.rows + 1) - (m.rows * m.cols - 1);
  if (calls.moveTo !== wantSegs) r.fail(`drew ${calls.moveTo} wall segments, want ${wantSegs}`);
  if (calls.fillText !== 2) r.fail(`drew ${calls.fillText} animals, want 2`);

  // Regression: the animals must not inherit a translucent fill from the cell
  // tint, or colour emoji come out washed out.
  for (const s of calls.fillTextStyles || []) {
    const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(s);
    if (alpha && Number(alpha[1]) < 1) r.fail(`an animal was drawn at alpha ${alpha[1]} (fill "${s}")`);
  }

  if (get('level').textContent !== `Maze 1 of ${n}`) r.fail(`header says "${get('level').textContent}"`);
  const wantStars = '★'.repeat(m.stars) + '☆'.repeat(5 - m.stars);
  if (get('stars').textContent !== wantStars) r.fail(`stars say "${get('stars').textContent}", want "${wantStars}"`);

  // Reconstruct the geometry the way fit() computes it, to aim the pointer.
  const cellFor = (mz) =>
    Math.max(12, Math.floor(Math.min((STAGE_W - SIDE * 2) / mz.cols, (STAGE_H - 20) / mz.rows)));
  const cell = cellFor(m);
  const wallW = Math.max(2, Math.round(cell * 0.11));
  // frac takes cell coordinates rather than cell numbers, so a pointer can be
  // put part of the way into a cell: 3.5 is the middle of row 3, 3.2 is a fifth
  // of the way in from its top edge.
  const frac = (fr, fc) => ({
    clientX: wallW / 2 + fc * cell,
    clientY: wallW / 2 + fr * cell,
    pointerId: 1, preventDefault() {},
  });
  const at = (row, col) => frac(row + 0.5, col + 0.5);
  // between walks from the middle of one cell towards the middle of another:
  // t of 0.5 lands on the wall between them, 0.7 a fifth of a cell past it.
  const between = (from, to, t) =>
    frac(from[0] + 0.5 + t * (to[0] - from[0]), from[1] + 0.5 + t * (to[1] - from[1]));
  const fire = (type, ev) => (ink._handlers[type] || []).forEach((h) => h(ev));
  const headCell = () => {
    const a = (calls.arcs || [])[0];
    return a && [
      Math.round((a[1] - wallW / 2 - cell / 2) / cell),
      Math.round((a[0] - wallW / 2 - cell / 2) / cell),
    ];
  };

  // 2. The finger holds the end of a string, not the head, so a touch
  //    anywhere on the board picks it up at the start animal and goes no
  //    further until the finger moves.
  calls.arcs = [];
  fire('pointerdown', at(m.rows - 1, m.cols - 1));
  fire('pointerup', at(m.rows - 1, m.cols - 1));
  if (String(headCell()) !== String(m.start)) r.fail(`a touch far off put the head at ${headCell()}, want the start`);

  // 3. A full drag along the solution wins and shows the end animal.
  fire('pointerdown', at(m.start[0], m.start[1]));
  for (const [row, col] of m.solution) fire('pointermove', at(row, col));
  fire('pointerup', at(m.end[0], m.end[1]));
  if (get('cheer').hidden) r.fail('tracing the solution did not celebrate');
  if (get('cheer-mark').textContent !== m.endMark) r.fail('celebration shows the wrong animal');
  if (!calls.stroke) r.fail('the trail was never stroked');
  // The trail is a rainbow, not one flat colour: the solution is long enough to
  // run through several hues.
  const hues = new Set([...(calls.colourStops || [])].map((c) => String(c).match(/hsl\((\d+)/)?.[1]));
  if (hues.size < 3) r.fail(`the trail used ${hues.size} colours, want a rainbow`);

  // 4. Reset clears the celebration.
  click('reset');
  if (!get('cheer').hidden) r.fail('reset left the celebration up');

  // 5. A hand shaking on the spot must not eat the trail behind it, while a
  //    finger that genuinely goes back a cell still retreats. A fingertip is
  //    wider than a cell, so without that margin every tremor cost a cell.
  const sol = m.solution;
  fire('pointerdown', at(m.start[0], m.start[1]));

  // Regression: the trail begins on top of the animal it set out from, and the
  // walls beneath it are not redrawn mid-drag, so the start animal must be put
  // down again over the ink or it disappears for the rest of the maze.
  const glyphs = calls.fillText;
  fire('pointermove', at(sol[1][0], sol[1][1]));
  if (calls.fillText === glyphs) r.fail('the trail buried the start animal');

  fire('pointermove', at(sol[2][0], sol[2][1]));
  // The head's position is continuous. A tug back short of a full step slides
  // it most of the way back but gives nothing up: lift the finger there and
  // the trail still holds all three cells, with the head drawn part-way.
  const trail = () => JSON.parse(globalThis.localStorage.getItem('maze.trail.v1')).path.length;
  fire('pointermove', between(sol[2], sol[1], 0.9));     // nine-tenths of a step back
  calls.arcs = [];
  fire('pointerup', between(sol[2], sol[1], 0.9));
  if (trail() !== 3) r.fail(`a tug short of a step left ${trail()} cells, want 3`);
  if (String(headCell()) !== String(sol[1])) r.fail(`the head did not glide back with the tug: drawn at ${headCell()}`);
  // Picking the string up again carries on from there: a little more and
  // the cell is given up.
  fire('pointerdown', at(sol[2][0], sol[2][1]));
  fire('pointermove', between(sol[2], sol[1], 0.2));
  calls.arcs = [];
  // A sideways pull the head cannot follow shows as a stretch.
  const walls = new (loadLogic().Maze)(m);
  const side = [[0, 1], [0, -1], [1, 0], [-1, 0]].find(([dr, dc]) =>
    (dr !== sol[0][0] - sol[1][0] || dc !== sol[0][1] - sol[1][1]) &&
    !walls.linked(sol[1][0], sol[1][1], sol[1][0] + dr, sol[1][1] + dc));
  if (side) {
    const p = between(sol[2], sol[1], 0.2);
    fire('pointermove', { ...p, clientX: p.clientX + side[1] * cell * 0.3, clientY: p.clientY + side[0] * cell * 0.3 });
    if (!calls.ellipse) r.fail('a pull into a wall did not stretch the head');
  }
  fire('pointerup', at(sol[1][0], sol[1][1]));
  if (trail() !== 2) r.fail(`a full step back left ${trail()} cells, want 2`);

  // 5b. Lifting the finger leaves a guard against the back swipe, and the
  //     swipe only spends the guard: the page puts it back while there is a
  //     trail to keep. The trail itself is saved as well.
  if (!pushed.length) r.fail('no history entry was pushed to catch a back swipe');
  const guards = pushed.length;
  fireWin('popstate');
  if (pushed.length !== guards + 1) r.fail('a back swipe mid-maze was not caught again');
  const saved = JSON.parse(globalThis.localStorage.getItem('maze.trail.v1') || 'null');
  if (!saved || saved.path.length !== 2) r.fail(`saved trail is ${JSON.stringify(saved && saved.path)}, want 2 cells`);

  // 6. Undo hands back the trail as it stood before the last gesture, and
  //    before Again too: neither a bad drag nor a mistap should cost a run.
  click('reset');
  fire('pointerdown', at(m.start[0], m.start[1]));
  for (const [row, col] of sol) fire('pointermove', at(row, col));
  fire('pointerup', at(m.end[0], m.end[1]));
  if (get('undo').disabled) r.fail('a drag that drew a trail left nothing to undo');
  click('reset');
  calls.arcs = [];
  click('undo');
  if (String(headCell()) !== String(m.end)) r.fail(`undo after Again left the head at ${headCell()}`);
  // Down to nothing: the head is the only disc drawn filled, so an undo that
  // fills nothing is one that gave back an empty trail. (Counting arcs would
  // not do — the "start here" ring is one too.)
  let fills = 0;
  for (let k = 0; k < 40 && !get('undo').disabled; k++) { fills = calls.fill | 0; click('undo'); }
  if (!get('undo').disabled) r.fail('undo never ran out of trails to give back');
  if ((calls.fill | 0) !== fills) r.fail('undoing everything left a trail behind');

  // 7. The info line reports what this maze actually is.
  const info = get('info').textContent.replace(/ /g, ' ');   // hard spaces within items
  for (const part of [`#1/${n}`, `${m.rows}×${m.cols}`, m.algo,
                      `${m.steps} steps`, `${m.junctions} junctions`, `score ${m.score}`]) {
    if (!info.includes(part)) r.fail(`info line "${info}" is missing "${part}"`);
  }

  // 8. The hint button is gone from the markup, the code and the styles.
  for (const f of ['app.js', 'index.html', 'style.css']) {
    if (fs.readFileSync(path.join(DOCS, f), 'utf8').toLowerCase().includes('hint')) {
      r.fail(`${f} still mentions the hint button`);
    }
  }

  // 9. Next advances the level and saves the progress.
  click('next');
  if (get('level').textContent !== `Maze 2 of ${n}`) r.fail(`next gave "${get('level').textContent}"`);
  if (JSON.parse(globalThis.localStorage.getItem('maze.progress.v1')).level !== 1) r.fail('progress not saved');

  // 10. The endless button is there from the start, once the generator is ready.
  if (!globalThis.mazeGenerate) r.fail('the fake wasm never loaded, so this proves nothing');
  if (get('endless').hidden) r.fail('endless button hidden even though the generator is ready');

  // 11. It switches to endless and back without losing his place in the pack.
  const wasAt = get('info').textContent;
  click('endless');
  if (!get('info').textContent.startsWith('∞')) r.fail('the button did not switch to endless mode');
  if (get('endless').getAttribute('aria-pressed') !== 'true') r.fail('endless button not marked pressed');
  click('endless');
  if (get('info').textContent !== wasAt) r.fail(`came back to "${get('info').textContent}", want "${wasAt}"`);

  // 12. Running off the end of the pack switches to endless by itself, and
  //      coming back must not fall off the end of the array.
  for (let i = 0; i < n + 2; i++) click('next');
  if (!get('info').textContent.startsWith('∞')) r.fail('did not switch to endless at the end of the pack');
  // Next in endless mode moves the count on even without a win, or a skip
  // looks like a button that does nothing.
  const was = get('level').textContent;
  click('next');
  if (get('level').textContent === was) r.fail(`Next in endless mode stayed on "${was}"`);
  click('endless');
  const back = get('info').textContent;
  if (!back.startsWith(`#${n}/`)) r.fail(`came back to "${back}", want the last maze`);

  // 13. The grown-ups' reset asks first, and a no leaves everything alone.
  const asked = [];
  define('confirm', (msg) => { asked.push(msg); return false; });
  globalThis.localStorage.setItem('maze.progress.v1', '{"level":3}');
  click('wipe');
  if (!asked.length) r.fail('the reset button went ahead without asking');
  if (!globalThis.localStorage.getItem('maze.progress.v1')) r.fail('answering no threw the progress away');
  if (reloads) r.fail('answering no reloaded anyway');

  // 14. A yes takes the progress, every cached file and the worker with it,
  //     and only then comes back for a fresh copy of the app.
  const dropped = [];
  let unregistered = 0;
  define('confirm', () => true);
  define('caches', {
    keys: () => Promise.resolve(['maze-v1', 'maze-v2']),
    delete: (k) => { dropped.push(k); return Promise.resolve(true); },
  });
  define('navigator', {
    serviceWorker: {
      getRegistration: () => Promise.resolve({
        unregister: () => { unregistered++; return Promise.resolve(true); },
      }),
    },
  });
  click('wipe');
  if (globalThis.localStorage.getItem('maze.progress.v1')) r.fail('the progress survived the reset');

  // The clearing is promised, so give it a turn of the loop before judging it.
  setTimeout(() => {
    if (dropped.length !== 2) r.fail(`dropped ${dropped.length} caches, want 2`);
    if (!unregistered) r.fail('the service worker was left registered');
    if (!reloads) r.fail('the app never came back for a fresh copy');
    resumeCheck(() => r.done(
      `info line: ${info}`,
      `maze 1: ${m.rows}x${m.cols} at ${cell}px cells -> canvas ${ink.style.width} x ${ink.style.height}`,
    ), cellFor);
  }, 0);
}, 50);

// 15. Closing the app halfway — a stray edge swipe, say — and opening it again
//     brings back the trail as it was, on the biggest maze in the pack, where
//     cells are small enough for the fingertip margins to matter. The same
//     app is loaded a second time over the stored progress to prove it.
function resumeCheck(done, cellFor) {
  const lv = pack.mazes.length - 1;
  const big = pack.mazes[lv];
  const sol = big.solution;
  const half = sol.slice(0, Math.floor(sol.length / 2));
  globalThis.localStorage._v = {
    'maze.progress.v1': JSON.stringify({ level: lv, endless: false, endlessWins: 0 }),
    'maze.trail.v1': JSON.stringify({ endless: false, level: lv, wins: 0, board: null, path: half }),
  };
  for (const k of Object.keys(nodes)) delete nodes[k];
  el._ctx = {};
  calls.arcs = [];
  define('Go', undefined);                       // no wasm this time: stay in the pack
  delete require.cache[require.resolve(path.join(DOCS, 'app.js'))];
  require(path.join(DOCS, 'app.js'));

  setTimeout(() => {
    const cell = cellFor(big);
    const wallW = Math.max(2, Math.round(cell * 0.11));
    const frac = (fr, fc) => ({ clientX: wallW / 2 + fc * cell, clientY: wallW / 2 + fr * cell, pointerId: 1, preventDefault() {} });
    const ink = get('ink');
    const fire = (type, ev) => (ink._handlers[type] || []).forEach((h) => h(ev));
    const head = () => {
      // The head is the disc a fifth of a cell across; anything else is the
      // "start here" ring still fading out from the first run of the app.
      const a = calls.arcs.filter((x) => Math.abs(x[2] - cell * 0.2) < 1e-6).pop();
      return a && String([Math.round((a[1] - wallW / 2 - cell / 2) / cell), Math.round((a[0] - wallW / 2 - cell / 2) / cell)]);
    };
    const at = half[half.length - 1], prev = half[half.length - 2];
    if (head() !== String(at)) r.fail(`reopened with the head at ${head()}, want ${at}`);

    // A finger going back down on the cell behind the head, as near as a
    // fingertip lands, carries on from the head rather than giving up a cell.
    calls.arcs = [];
    const back = frac(prev[0] + 0.5 + (at[0] - prev[0]) * 0.3, prev[1] + 0.5 + (at[1] - prev[1]) * 0.3);
    fire('pointerdown', back);
    fire('pointerup', back);
    if (calls.arcs.length && head() !== String(at)) r.fail(`touching down beside the head moved it to ${head()}`);
    done();
  }, 50);
}
