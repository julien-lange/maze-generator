'use strict';

// Runs docs/app.js for real against a stub DOM: loads the pack, lays out and
// draws the canvases, then fires genuine pointer events and checks what got
// drawn. This is the suite that catches anything which only breaks once the
// drawing and pointer code actually runs.

const fs = require('fs');
const path = require('path');
const { DOCS, readPack, results } = require('./harness');

const pack = readPack();
const r = results('PLAYER CHECKS');
const calls = {};

function ctx2d() {
  const rec = (name) => (...a) => { calls[name] = (calls[name] || 0) + 1; return a; };
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 0, lineCap: '', lineJoin: '',
    textAlign: '', textBaseline: '',
    setTransform: rec('setTransform'), clearRect: rec('clearRect'), fillRect: rec('fillRect'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    stroke: rec('stroke'), fill: rec('fill'), setLineDash: rec('setLineDash'),
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

const nodes = {};
const get = (id) => (nodes[id] = nodes[id] || el(id));
const click = (id) => (get(id)._handlers.click || []).forEach((h) => h());

// defineProperty rather than assignment: recent Node versions define some of
// these (navigator, for one) as getter-only globals, which a plain assignment
// silently drops in sloppy mode and throws over in strict.
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

define('window', globalThis);
define('document', { getElementById: get, createElement: () => el('span'), addEventListener: () => {} });
define('location', { protocol: 'file:' });          // keeps the service worker out of the way
define('navigator', {});                            // no serviceWorker in it, so none is registered
define('matchMedia', () => ({ matches: true }));    // reduced motion: suppress confetti
define('ResizeObserver', class { observe() {} });
define('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
define('devicePixelRatio', 2);
define('localStorage', {
  _v: {},
  getItem(k) { return this._v[k] || null; },
  setItem(k, v) { this._v[k] = v; },
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
  const cell = Math.max(12, Math.floor(Math.min((STAGE_W - 20) / m.cols, (STAGE_H - 20) / m.rows)));
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

  // 2. A tap far from the start draws nothing at all.
  const before = { stroke: calls.stroke | 0, arc: calls.arc | 0 };
  fire('pointerdown', at(m.rows - 1, m.cols - 1));
  fire('pointerup', at(m.rows - 1, m.cols - 1));
  if ((calls.stroke | 0) !== before.stroke || (calls.arc | 0) !== before.arc) {
    r.fail('a tap away from the start began a trail');
  }

  // 3. A full drag along the solution wins and shows the end animal.
  fire('pointerdown', at(m.start[0], m.start[1]));
  for (const [row, col] of m.solution) fire('pointermove', at(row, col));
  fire('pointerup', at(m.end[0], m.end[1]));
  if (get('cheer').hidden) r.fail('tracing the solution did not celebrate');
  if (get('cheer-mark').textContent !== m.endMark) r.fail('celebration shows the wrong animal');
  if (!calls.stroke) r.fail('the trail was never stroked');

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
  calls.arcs = [];
  fire('pointermove', between(sol[2], sol[1], 0.7));     // a fifth of a cell back
  if (calls.arcs.length) r.fail(`a wobble backwards moved the head to ${headCell()}`);
  fire('pointermove', between(sol[2], sol[1], 0.95));    // properly into the cell behind
  if (String(headCell()) !== String(sol[1])) r.fail(`a step back left the head at ${headCell()}`);
  fire('pointerup', at(sol[1][0], sol[1][1]));

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
  click('endless');
  const back = get('info').textContent;
  if (!back.startsWith(`#${n}/`)) r.fail(`came back to "${back}", want the last maze`);

  r.done(
    `info line: ${info}`,
    `maze 1: ${m.rows}x${m.cols} at ${cell}px cells -> canvas ${ink.style.width} x ${ink.style.height}`,
  );
}, 50);
