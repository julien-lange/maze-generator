'use strict';

// The player. It knows nothing about how a maze was made: it reads the wire
// format from pack.go, whether that arrived in pack.json or came back from the
// WebAssembly generator a moment ago.

const PACK_URL = 'pack.json';
const STORE_KEY = 'maze.progress.v1';

/* ------------------------------------------------------------------ maze */

// decodeBits unpacks base64 written by packBits: bit i of the flattened wall
// array lives in bit i%8 of byte i/8, least significant first.
function decodeBits(b64, count) {
  const bytes = atob(b64);
  const bits = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    bits[i] = (bytes.charCodeAt(i >> 3) >> (i & 7)) & 1;
  }
  return bits;
}

class Maze {
  constructor(d) {
    this.rows = d.rows;
    this.cols = d.cols;
    this.east = decodeBits(d.east, d.rows * (d.cols - 1));
    this.south = decodeBits(d.south, (d.rows - 1) * d.cols);
    this.start = d.start;
    this.end = d.end;
    this.startMark = d.startMark;
    this.endMark = d.endMark;
    this.solution = d.solution || [];
    this.stars = d.stars || 0;
    // Measured in Go when the maze was carved; shown in the line under the
    // board so its difficulty can be tracked rather than guessed at.
    this.algo = d.algo || '?';
    this.steps = d.steps || 0;
    this.junctions = d.junctions || 0;
    this.score = d.score || 0;
  }

  inside(r, c) { return r >= 0 && r < this.rows && c >= 0 && c < this.cols; }

  // Off-grid queries report false, so the outer boundary comes out closed
  // without a special case — the same trick print.go leans on.
  openEast(r, c) {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols - 1 &&
      this.east[r * (this.cols - 1) + c] === 1;
  }
  openSouth(r, c) {
    return r >= 0 && r < this.rows - 1 && c >= 0 && c < this.cols &&
      this.south[r * this.cols + c] === 1;
  }

  // linked reports whether one can step directly between two adjacent cells.
  linked(r1, c1, r2, c2) {
    if (r1 === r2) {
      if (c2 === c1 + 1) return this.openEast(r1, c1);
      if (c1 === c2 + 1) return this.openEast(r1, c2);
    } else if (c1 === c2) {
      if (r2 === r1 + 1) return this.openSouth(r1, c1);
      if (r1 === r2 + 1) return this.openSouth(r2, c1);
    }
    return false;
  }
}

/* ----------------------------------------------------------------- state */

const wallsCanvas = document.getElementById('walls');
const inkCanvas = document.getElementById('ink');
const wallsCtx = wallsCanvas.getContext('2d');
const inkCtx = inkCanvas.getContext('2d');
const stage = document.getElementById('stage');
const cheer = document.getElementById('cheer');
const nextBtn = document.getElementById('next');
const infoEl = document.getElementById('info');
const endlessBtn = document.getElementById('endless');

let maze = null;
let pack = [];
let level = 0;          // index into pack
let endless = false;    // generating fresh mazes instead of reading the pack
let endlessWins = 0;
let wasmReady = false;

let path = [];          // the trail, as [row, col] cells
let seen = new Map();   // "row,col" -> position in path, for O(1) backtracking
let drawing = false;
let won = false;
let celebrated = false;   // one cheer per arrival, however much he wiggles
let cheerTimer = 0;

let cell = 0, wallW = 0, ox = 0, oy = 0;
let pulseUntil = 0, pulsing = false;

/* -------------------------------------------------------------- geometry */

// fit sizes the canvases so the maze fills the space left between the header
// and the buttons, at whole-pixel cells.
function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pad = 10;
  const availW = stage.clientWidth - pad * 2;
  const availH = stage.clientHeight - pad * 2;

  cell = Math.max(12, Math.floor(Math.min(availW / maze.cols, availH / maze.rows)));
  wallW = Math.max(2, Math.round(cell * 0.11));
  ox = oy = wallW / 2;

  const w = maze.cols * cell + wallW;
  const h = maze.rows * cell + wallW;
  for (const cv of [wallsCanvas, inkCanvas]) {
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

const px = (col) => ox + col * cell;          // left edge of a column
const py = (row) => oy + row * cell;          // top edge of a row
const cx = (col) => px(col) + cell / 2;       // centre of a cell
const cy = (row) => py(row) + cell / 2;

/* --------------------------------------------------------------- drawing */

function drawWalls() {
  const w = maze.cols * cell + wallW;
  const h = maze.rows * cell + wallW;

  wallsCtx.clearRect(0, 0, w, h);
  wallsCtx.fillStyle = '#fbf7ee';
  wallsCtx.fillRect(0, 0, w, h);

  tintCell(maze.start, 'rgba(46, 164, 79, .14)');
  tintCell(maze.end, 'rgba(242, 183, 5, .20)');

  wallsCtx.strokeStyle = '#2f3542';
  wallsCtx.lineWidth = wallW;
  wallsCtx.lineCap = 'round';
  wallsCtx.beginPath();
  for (let i = 0; i <= maze.rows; i++) {          // walls above row i
    for (let j = 0; j < maze.cols; j++) {
      if (!maze.openSouth(i - 1, j)) {
        wallsCtx.moveTo(px(j), py(i));
        wallsCtx.lineTo(px(j + 1), py(i));
      }
    }
  }
  for (let j = 0; j <= maze.cols; j++) {          // walls left of column j
    for (let i = 0; i < maze.rows; i++) {
      if (!maze.openEast(i, j - 1)) {
        wallsCtx.moveTo(px(j), py(i));
        wallsCtx.lineTo(px(j), py(i + 1));
      }
    }
  }
  wallsCtx.stroke();

  mark(maze.start, maze.startMark);
  mark(maze.end, maze.endMark);
}

function tintCell([r, c], colour) {
  wallsCtx.fillStyle = colour;
  wallsCtx.fillRect(px(c), py(r), cell, cell);
}

function mark([r, c], glyph) {
  wallsCtx.font = Math.floor(cell * 0.62) + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  wallsCtx.textAlign = 'center';
  wallsCtx.textBaseline = 'middle';
  wallsCtx.fillText(glyph, cx(c), cy(r) + cell * 0.04);
}

function drawInk() {
  const w = maze.cols * cell + wallW;
  const h = maze.rows * cell + wallW;
  inkCtx.clearRect(0, 0, w, h);

  if (path.length) {
    stroke(path, won ? '#f2b705' : '#ff6b35', cell * 0.34);
    const [r, c] = path[path.length - 1];        // the head, so he can see the anchor
    inkCtx.fillStyle = won ? '#f2b705' : '#ff6b35';
    inkCtx.beginPath();
    inkCtx.arc(cx(c), cy(r), cell * 0.2, 0, Math.PI * 2);
    inkCtx.fill();
  }

  const left = pulseUntil - performance.now();
  if (left > 0) {                                // "start here" ring
    const [r, c] = maze.start;
    inkCtx.strokeStyle = 'rgba(46, 164, 79,' + (left / 900) * 0.9 + ')';
    inkCtx.lineWidth = Math.max(3, cell * 0.1);
    inkCtx.beginPath();
    inkCtx.arc(cx(c), cy(r), cell * (0.75 - (left / 900) * 0.3), 0, Math.PI * 2);
    inkCtx.stroke();
  }
}

function stroke(cells, colour, width) {
  if (cells.length === 0) return;
  inkCtx.strokeStyle = colour;
  inkCtx.lineWidth = width;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  inkCtx.beginPath();
  inkCtx.moveTo(cx(cells[0][1]), cy(cells[0][0]));
  for (let i = 1; i < cells.length; i++) {
    inkCtx.lineTo(cx(cells[i][1]), cy(cells[i][0]));
  }
  if (cells.length === 1) inkCtx.lineTo(cx(cells[0][1]), cy(cells[0][0]));
  inkCtx.stroke();
}

function pulseStart() {
  pulseUntil = performance.now() + 900;
  if (pulsing) return;
  pulsing = true;
  const tick = () => {
    drawInk();
    if (performance.now() < pulseUntil) requestAnimationFrame(tick);
    else pulsing = false;
  };
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ path */

const key = (r, c) => r * maze.cols + c;

// advance moves the head one cell. Stepping back onto the trail rewinds to that
// point rather than doubling back over itself, so retreating out of a dead end
// is the same gesture as walking into it.
function advance(r, c) {
  const k = key(r, c);
  if (seen.has(k)) {
    const at = seen.get(k);
    for (let i = path.length - 1; i > at; i--) seen.delete(key(path[i][0], path[i][1]));
    path.length = at + 1;
  } else {
    seen.set(k, path.length);
    path.push([r, c]);
  }
  won = path[path.length - 1][0] === maze.end[0] && path[path.length - 1][1] === maze.end[1];
  if (!won) celebrated = false;   // backed out again: arriving can count afresh
}

// walkTowards steps the head at most a few cells towards a target, one open
// wall at a time. A finger moving fast reports positions several cells apart,
// and this is what turns those jumps back into a legal walk.
function walkTowards(tr, tc) {
  // Landing back on the trail always means retreating, so rewind straight to
  // that cell. Stepping there geometrically could round a corner onto a
  // neighbouring corridor instead, which is how a quick flick backwards would
  // otherwise sprout a branch he never drew.
  if (seen.has(key(tr, tc))) {
    advance(tr, tc);
    return;
  }

  for (let guard = 0; guard < 64; guard++) {
    const [r, c] = path[path.length - 1];
    if (r === tr && c === tc) return;

    const dr = Math.sign(tr - r), dc = Math.sign(tc - c);
    // Try the axis with further to go first; the diagonal case then resolves
    // into whichever of the two steps the walls actually allow.
    const order = Math.abs(tr - r) >= Math.abs(tc - c) ? [[dr, 0], [0, dc]] : [[0, dc], [dr, 0]];

    let moved = false;
    for (const [sr, sc] of order) {
      if (sr === 0 && sc === 0) continue;
      const nr = r + sr, nc = c + sc;
      if (!maze.inside(nr, nc)) continue;
      if (!maze.linked(r, c, nr, nc)) continue;
      advance(nr, nc);
      moved = true;
      break;
    }
    if (!moved) return;   // walled in on both axes: the finger has run ahead
  }
}

function cellAt(e) {
  const box = inkCanvas.getBoundingClientRect();
  const r = Math.floor((e.clientY - box.top - oy) / cell);
  const c = Math.floor((e.clientX - box.left - ox) / cell);
  return [
    Math.min(maze.rows - 1, Math.max(0, r)),
    Math.min(maze.cols - 1, Math.max(0, c)),
  ];
}

function resetPath() {
  path = [];
  seen = new Map();
  won = false;
  celebrated = false;
  drawing = false;
  clearTimeout(cheerTimer);
  cheer.hidden = true;
  nextBtn.classList.remove('ready');
  drawInk();
}

/* -------------------------------------------------------------- pointers */

inkCanvas.addEventListener('pointerdown', (e) => {
  const [r, c] = cellAt(e);

  if (path.length === 0) {
    // Only the start counts, but generously: anywhere in the eight cells
    // around it snaps to it, because a fingertip is wider than a cell.
    if (Math.abs(r - maze.start[0]) > 1 || Math.abs(c - maze.start[1]) > 1) {
      pulseStart();
      return;
    }
    advance(maze.start[0], maze.start[1]);
  } else if (seen.has(key(r, c))) {
    advance(r, c);            // grabbed the trail partway along: rewind to here
  } else {
    const [hr, hc] = path[path.length - 1];
    if (Math.abs(r - hr) + Math.abs(c - hc) > 1) return;  // nowhere near the head
  }

  drawing = true;
  inkCanvas.setPointerCapture(e.pointerId);
  walkTowards(r, c);
  drawInk();
  if (won) celebrate();
  e.preventDefault();
});

inkCanvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const [r, c] = cellAt(e);
  const before = path.length;
  walkTowards(r, c);
  if (path.length !== before) {
    drawInk();
    if (won) celebrate();
  }
  e.preventDefault();
});

for (const type of ['pointerup', 'pointercancel']) {
  inkCanvas.addEventListener(type, (e) => {
    drawing = false;
    if (inkCanvas.hasPointerCapture(e.pointerId)) inkCanvas.releasePointerCapture(e.pointerId);
  });
}

// The maze must never scroll under the finger, on any browser.
inkCanvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ----------------------------------------------------------- celebration */

function celebrate() {
  if (celebrated) return;
  celebrated = true;
  document.getElementById('cheer-mark').textContent = maze.endMark;
  cheer.hidden = false;
  nextBtn.classList.add('ready');
  // Take the card away again so he can admire the path he drew; the glowing
  // Next button is what carries on saying well done.
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => { cheer.hidden = true; }, 2600);
  confetti();
  if (!endless) save();
  else { endlessWins++; save(); }
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const glyphs = [maze.startMark, maze.endMark, '🎉', '⭐'];
  for (let i = 0; i < 18; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti';
    bit.textContent = glyphs[i % glyphs.length];
    bit.style.left = Math.random() * 100 + '%';
    bit.style.animationDuration = (1.6 + Math.random() * 1.2) + 's';
    bit.style.animationDelay = (Math.random() * 0.4) + 's';
    bit.addEventListener('animationend', () => bit.remove());
    stage.appendChild(bit);
  }
}

/* ------------------------------------------------------------- the mazes */

function show(data) {
  maze = new Maze(data);
  resetPath();
  fit();
  drawWalls();
  drawInk();

  document.getElementById('level').textContent =
    endless ? 'Maze ' + (endlessWins + 1) : 'Maze ' + (level + 1) + ' of ' + pack.length;
  document.getElementById('stars').textContent =
    endless ? '∞' : '★'.repeat(maze.stars) + '☆'.repeat(5 - maze.stars);
  infoEl.textContent = [
    endless ? '∞ #' + (endlessWins + 1) : '#' + (level + 1) + '/' + pack.length,
    maze.rows + '×' + maze.cols,
    maze.algo,
    maze.steps + ' steps',
    maze.junctions + ' junctions',
    'score ' + maze.score,
    // Hard spaces inside each item, ordinary ones between: on a narrow phone
    // the line then breaks between facts rather than through the middle of one.
  ].map((s) => s.replace(/ /g, ' ')).join(' · ');
}

// endlessShape asks for a maze that will exactly fill this screen at a
// comfortable finger size, shrinking the cells a little as he gets better.
function endlessShape() {
  const target = Math.max(22, 34 - endlessWins);
  return {
    rows: Math.min(40, Math.max(6, Math.floor((stage.clientHeight - 20) / target))),
    cols: Math.min(30, Math.max(5, Math.floor((stage.clientWidth - 20) / target))),
  };
}

function nextMaze() {
  if (endless) {
    const { rows, cols } = endlessShape();
    show(JSON.parse(window.mazeGenerate(rows, cols, Math.floor(Math.random() * 2 ** 53), 14)));
    return;
  }
  level++;
  if (level >= pack.length) {
    if (wasmReady) { setEndless(true); return; }   // pack finished: keep going
    level = 0;
  }
  save();
  show(pack[level]);
}

function setEndless(on) {
  endless = on && wasmReady;
  endlessBtn.setAttribute('aria-pressed', String(endless));
  save();
  if (endless) nextMaze();
  else show(pack[level]);
}

/* ------------------------------------------------------------- progress */

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ level, endless, endlessWins }));
  } catch (_) { /* private browsing: not worth caring about */ }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch (_) { return {}; }
}

/* ------------------------------------------------------------- controls */

document.getElementById('reset').addEventListener('click', resetPath);
nextBtn.addEventListener('click', nextMaze);

endlessBtn.addEventListener('click', () => setEndless(!endless));

new ResizeObserver(() => {
  if (!maze) return;
  fit();
  drawWalls();
  drawInk();
}).observe(stage);

/* ----------------------------------------------------------------- wasm */

// The WebAssembly build is the same generator as the command line, so a fresh
// maze and a packed one are indistinguishable by the time they get here. It is
// entirely optional: without it the pack still plays.
function loadWasm() {
  if (typeof Go !== 'function') return;
  const go = new Go();
  const start = (result) => {
    go.run(result.instance);            // returns at the first block; the
    wasmReady = true;                   // export is set before that happens
    endlessBtn.hidden = false;
  };
  const bytes = () => fetch('maze.wasm')
    .then((r) => r.arrayBuffer())
    .then((b) => WebAssembly.instantiate(b, go.importObject));

  if (WebAssembly.instantiateStreaming) {
    WebAssembly.instantiateStreaming(fetch('maze.wasm'), go.importObject)
      .then(start)
      .catch(() => bytes().then(start).catch(() => {}));   // wrong MIME type, say
  } else {
    bytes().then(start).catch(() => {});
  }
}

/* ----------------------------------------------------------------- start */

fetch(PACK_URL)
  .then((r) => r.json())
  .then((data) => {
    pack = data.mazes;
    const saved = load();
    level = Math.min(Math.max(saved.level | 0, 0), pack.length - 1);
    endlessWins = saved.endlessWins | 0;
    show(pack[level]);
    loadWasm();
  })
  .catch(() => {
    document.getElementById('level').textContent = 'Could not load pack.json';
  });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
