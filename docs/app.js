'use strict';

// The player. It knows nothing about how a maze was made: it reads the wire
// format from pack.go, whether that arrived in pack.json or came back from the
// WebAssembly generator a moment ago.

const PACK_URL = 'pack.json';
const STORE_KEY = 'maze.progress.v1';
const TRAIL_KEY = 'maze.trail.v1';

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
const undoBtn = document.getElementById('undo');
const themeBtn = document.getElementById('theme');

/* ---------------------------------------------------------------- themes */

// Two looks for the same game. Classic is slate and orange, with a plain
// orange trail that turns gold when the maze is solved; magic is purple and
// pink with a rainbow trail. The page colours live in style.css, keyed on
// <html data-theme>; these are the ones painted on the canvas.
const THEMES = {
  classic: {
    paper: '#fbf7ee', ink: '#2f3542', meta: '#2f3542',
    startTint: 'rgba(46, 164, 79, .14)', endTint: 'rgba(242, 183, 5, .20)',
    ring: '46, 164, 79', rainbow: false, trail: '#ff6b35', gold: '#f2b705',
    // The princess and her castle are for the magic look; classic ends on a goal.
    ends: { '👸': '🏆', '🧚': '⭐', '🧜': '🚀', '🏰': '🦖', '👑': '🐲', '🌈': '🦕', '💖': '🛸', '🌸': '🎯' },
    confetti: ['⭐', '✨', '🎉', '🏆'],
  },
  magic: {
    paper: '#fff7fb', ink: '#5a2d6e', meta: '#5a2d6e',
    startTint: 'rgba(126, 200, 255, .20)', endTint: 'rgba(255, 105, 180, .20)',
    ring: '255, 105, 180', rainbow: true, ends: {},
    confetti: ['💖', '✨', '🌈', '🦋'],
  },
};
const THEME_KEY = 'maze.theme.v1';
let themeName = 'classic';
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved in THEMES) themeName = saved;
} catch (_) { /* private browsing */ }
const T = () => THEMES[themeName];
const endMarkOf = (m) => T().ends[m.endMark] || m.endMark;

function applyTheme() {
  document.documentElement.dataset.theme = themeName;
  document.querySelector('meta[name="theme-color"]').content = T().meta;
  themeBtn.setAttribute('aria-pressed', String(themeName === 'magic'));
  themeBtn.textContent = themeName === 'magic' ? '🌈' : '🎨';
}
applyTheme();

let maze = null;
let pack = [];
let level = 0;          // index into pack
let endless = false;    // generating fresh mazes instead of reading the pack
let endlessWins = 0;    // endless mazes moved on from (won or skipped); the stored name is older
let wasmReady = false;
let wantEndless = false; // restore endless mode once the wasm has arrived
let stale = false;       // a newer app is waiting; go back for it at a safe moment

let path = [];          // the trail, as [row, col] cells
let seen = new Map();   // "row,col" -> position in path, for O(1) backtracking
let history = [];       // trails as they stood before each gesture, for Undo
let pending = null;     // the trail as it stood when this gesture began
let drawing = false;
let won = false;
let celebrated = false;   // one cheer per arrival, however much he wiggles
let cheerTimer = 0;

let cell = 0, wallW = 0, ox = 0, oy = 0;
let lastX = 0, lastY = 0;   // where the finger was, so each move is a pull on the rope
let current = null;       // the maze data on screen, kept so a trail can be saved with it
let resume = null;        // a trail saved last time, waiting for its maze to come back
let guarded = false;      // an extra history entry is in place to catch a back swipe
let pulseUntil = 0, pulsing = false;

/* -------------------------------------------------------------- geometry */

// On a touch screen the maze keeps clear of the left and right edges. Android
// treats a finger put down at the very edge as the system back gesture, and in
// the installed app that closes the maze mid-run. Keeping the board out of
// that strip means a finger going back down to carry on lands on the maze.
const SIDE = () => (matchMedia('(pointer: coarse)').matches ? 24 : 10);

// fit sizes the canvases so the maze fills the space left between the header
// and the buttons, at whole-pixel cells.
function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pad = 10;
  const availW = stage.clientWidth - SIDE() * 2;
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
  wallsCtx.fillStyle = T().paper;
  wallsCtx.fillRect(0, 0, w, h);

  tintCell(maze.start, T().startTint);
  tintCell(maze.end, T().endTint);

  wallsCtx.strokeStyle = T().ink;
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
  mark(maze.end, endMarkOf(maze));
}

function tintCell([r, c], colour) {
  wallsCtx.fillStyle = colour;
  wallsCtx.fillRect(px(c), py(r), cell, cell);
}

function mark([r, c], glyph, ctx = wallsCtx) {
  // Opaque fill, explicitly. Colour emoji are bitmap glyphs and the canvas
  // applies the fill's alpha to them, so inheriting the cell tint's rgba from
  // tintCell above would draw both animals at a fifth of their opacity.
  ctx.fillStyle = T().ink;
  ctx.font = Math.floor(cell * 0.62) + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, cx(c), cy(r) + cell * 0.04);
}

function drawInk() {
  const w = maze.cols * cell + wallW;
  const h = maze.rows * cell + wallW;
  inkCtx.clearRect(0, 0, w, h);

  if (path.length) {
    // Once the maze is solved, a white ribbon under the rainbow makes it shine.
    // The head glides: part-way through a step it is drawn that far along,
    // the trail growing (or shrinking back) under it, so a pull moves it
    // smoothly rather than a cell at a time.
    const g = glide();
    const body = g && g.back ? path.slice(0, -1) : path;
    const colour = won ? T().gold : T().trail;
    if (T().rainbow) {
      if (won) stroke(body, '#ffffff', cell * 0.5);
      rainbow(body, cell * 0.34);
    } else {
      stroke(body, colour, cell * 0.34);
    }
    const [r, c] = body[body.length - 1];
    let hx = cx(c), hy = cy(r), tipHue = T().rainbow ? hue(body.length - 1) : colour;
    if (g) {
      hx = g.x; hy = g.y;
      tipHue = T().rainbow ? hue(body.length - 1 + g.t) : colour;
      inkCtx.strokeStyle = tipHue;
      inkCtx.lineWidth = cell * 0.34;
      inkCtx.lineCap = 'round';
      inkCtx.beginPath();
      inkCtx.moveTo(cx(c), cy(r));
      inkCtx.lineTo(hx, hy);
      inkCtx.stroke();
    }
    inkCtx.fillStyle = tipHue;                    // the head, so he can see the anchor
    inkCtx.beginPath();
    inkCtx.arc(hx, hy, cell * 0.2, 0, Math.PI * 2);
    inkCtx.fill();
    stretchHead(hx, hy, cell * 0.2, 1);
    // The trail starts on top of the animal it set out from and would bury it.
    // It lives on the walls canvas, under the ink, so the only way to keep it
    // in sight is to put it down again over the trail.
    mark(maze.start, maze.startMark, inkCtx);
    // Likewise the one waiting at the end, once the trail has reached it.
    if (won) mark(maze.end, endMarkOf(maze), inkCtx);
  }

  const left = pulseUntil - performance.now();
  if (left > 0) {                                // "start here" ring
    const [r, c] = maze.start;
    inkCtx.strokeStyle = 'rgba(' + T().ring + ',' + (left / 900) * 0.9 + ')';
    inkCtx.lineWidth = Math.max(3, cell * 0.1);
    inkCtx.beginPath();
    inkCtx.arc(cx(c), cy(r), cell * (0.75 - (left / 900) * 0.3), 0, Math.PI * 2);
    inkCtx.stroke();
  }
}

// glide works out where the head is part-way through its next step: the
// cell the pull would take it to, and how far along it is drawn there. When
// the step is back over the trail, the head is drawn that far back instead
// and the last cell left off the body. Null when there is no pull to show.
function glide() {
  if (!path.length || !rope.edge || rope.s <= 0) return null;
  const best = [rope.edge.r, rope.edge.c, rope.edge.back];
  const t = Math.min(0.999, rope.s);
  const [hr, hc] = path[path.length - 1];
  if (best[2]) {
    // Going back: from the cell behind towards the head, shrinking.
    return { back: true, t: 1 - t,
      x: cx(hc) + (cx(best[1]) - cx(hc)) * t, y: cy(hr) + (cy(best[0]) - cy(hr)) * t };
  }
  return { back: false, t,
    x: cx(hc) + (cx(best[1]) - cx(hc)) * t, y: cy(hr) + (cy(best[0]) - cy(hr)) * t };
}

// stretchHead shows the pull on the string. While a finger drags, the head is
// drawn out towards it as a drop: longer and thinner the harder it pulls, up
// to a full step's worth, which is also how it looks held taut against a
// wall or at a fork. Let go and the pull is gone, so it springs back round.
function stretchHead(x, y, rad, amount) {
  if (!drawing) return;
  const len = Math.hypot(rope.tx, rope.ty);
  const t = Math.min(1, len / (stepPx() * 0.5)) * amount;
  if (t < 0.04) return;
  const ux = rope.tx / len, uy = rope.ty / len;
  const shift = rad * 1.3 * t;
  inkCtx.beginPath();
  inkCtx.ellipse(x + ux * shift, y + uy * shift,
    rad * (1 + 1.3 * t), rad * (1 - 0.35 * t), Math.atan2(uy, ux), 0, Math.PI * 2);
  inkCtx.fill();
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

// The trail is a rainbow: each step along it moves on by a fixed slice of the
// colour wheel, so the colours run red, orange, yellow, green, blue, violet,
// pink and round again every dozen cells, whatever the size of the maze.
const RAINBOW_STEP = 30;
const hue = (i) => 'hsl(' + ((i * RAINBOW_STEP) % 360) + ', 95%, 60%)';

// rainbow strokes the trail one step at a time, each step a gradient between
// the colours of the two cells it joins. Round caps make the steps overlap at
// the cell centres, and both are the same colour there, so there are no seams.
function rainbow(cells, width) {
  inkCtx.lineWidth = width;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  if (cells.length === 1) {
    stroke(cells, hue(0), width);
    return;
  }
  for (let i = 1; i < cells.length; i++) {
    const x0 = cx(cells[i - 1][1]), y0 = cy(cells[i - 1][0]);
    const x1 = cx(cells[i][1]), y1 = cy(cells[i][0]);
    const g = inkCtx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, hue(i - 1));
    g.addColorStop(1, hue(i));
    inkCtx.strokeStyle = g;
    inkCtx.beginPath();
    inkCtx.moveTo(x0, y0);
    inkCtx.lineTo(x1, y1);
    inkCtx.stroke();
  }
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

// settle works out what the trail now means. Backing out of the end undoes the
// win, so arriving there again can count afresh.
function settle() {
  const [r, c] = path[path.length - 1];
  won = r === maze.end[0] && c === maze.end[1];
  if (!won) celebrated = false;
}

// advance puts the head on a cell outright: a fresh one extends the trail, one
// already on it rewinds to that point. Only a deliberate gesture may do this —
// a finger put down on the trail partway along. A drag walks instead.
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
  settle();
}

// retreat takes the head back one cell, uncovering the cell it came from. The
// start is never given up: there is nowhere behind it to stand.
function retreat() {
  if (path.length < 2) return;
  const [r, c] = path.pop();
  seen.delete(key(r, c));
  settle();
}

// walkTowards steps the head at most a few cells towards a target, one open
// wall at a time. A finger moving fast reports positions several cells apart,
// and this is what turns those jumps back into a legal walk.
//
// Every move is a step between neighbours: forward onto fresh ground, or back
// over the cell just left. Nowhere else on the trail may be entered. These
// mazes are perfect, so a corridor commonly runs alongside the one it came
// from with a single wall between them — without that rule a fingertip
// straying a cell sideways lands on ground covered hundreds of steps ago, and
// unwinds every one of them.
function walkTowards(tr, tc) {
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
      if (seen.has(key(nr, nc))) {
        // The cell behind is the one square of trail a walk may re-enter.
        // Anything else under the finger is a stray, and a stray must cost
        // nothing at all rather than the whole run back to it.
        if (seen.get(key(nr, nc)) !== path.length - 2) return;
        retreat();
      } else {
        advance(nr, nc);
      }
      moved = true;
      break;
    }
    if (!moved) return;   // walled in on both axes: the finger has run ahead
  }
}

// The string. The finger does not have to be on the head: wherever it went
// down, every movement since is a pull on the head, which follows it along
// the corridors at one cell per cell of movement (see slide below).
//
// Which way the head goes from a cell is the open way that best matches the
// pull: onto fresh ground, or back onto the cell just left, which gives that
// cell up. Where the pull clearly points down one way (within 60 degrees of
// it), the head goes that way. Otherwise it waits, held taut, for the finger
// to lean one way: it never turns a corner the finger has not turned, so a
// pull along a corridor into a wall stops at the wall.
// choose picks the way a pull along (ux, uy), a unit vector, would take the
// head next: [row, col, back] with back true for the cell just left, or null
// where it would wait.
function choose(ux, uy) {
  const [r, c] = path[path.length - 1];
  const prev = path.length > 1 ? path[path.length - 2] : null;
  let best = null, bestCos = -2;
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = r + dr, nc = c + dc;
    if (!maze.linked(r, c, nr, nc)) continue;
    const back = Boolean(prev && prev[0] === nr && prev[1] === nc);
    if (!back && seen.has(key(nr, nc))) continue;    // older trail: never re-entered
    const cos = dc * ux + dr * uy;
    if (cos > bestCos) { bestCos = cos; best = [nr, nc, back]; }
  }
  return best && bestCos >= 0.5 ? best : null;
}

// The rope is where the head really is: on the cell at the end of the trail
// (edge null), or some fraction s of the way along the edge to a next cell
// (back: the cell just left, so going that way rewinds). Finger movement
// slides it along that edge continuously; the trail only changes when it
// arrives at the far end, or it comes back to the head and turns.
//
//   aim      movement gathered while standing on a cell, until it says which way
//   tx, ty   tension: movement the head could not follow, shown as a stretch
let rope = { edge: null, s: 0, aimX: 0, aimY: 0, tx: 0, ty: 0 };

function ropeReset() {
  rope = { edge: null, s: 0, aimX: 0, aimY: 0, tx: 0, ty: 0 };
}

// slide moves the head by a finger movement of (dx, dy) pixels, with step
// pixels to a cell.
//
// Along an edge the head moves by the part of the movement that points along
// it, so a sideways wobble moves it not at all and a slight wander costs only
// a little speed. On a cell it
// waits for a short, definite movement before choosing which way to go, so a
// tremor at a fork chooses nothing; once it is travelling it turns straight
// into the next edge without stopping.
function slide(dx, dy, step) {
  const decay = 0.8;
  rope.tx *= decay; rope.ty *= decay;
  let travelling = false;
  for (let guard = 0; guard < 64 && (dx || dy); guard++) {
    const len = Math.hypot(dx, dy);
    if (!rope.edge) {
      rope.aimX += dx; rope.aimY += dy;
      dx = dy = 0;
      const aim = Math.hypot(rope.aimX, rope.aimY);
      if (aim < (travelling ? 1e-9 : step * 0.15)) break;
      const best = choose(rope.aimX / aim, rope.aimY / aim);
      if (!best) {
        // Nowhere to go yet: held taut, the pull showing as a stretch, and
        // not piling up to fire off later all at once.
        const k = Math.min(aim, step * 0.5) / aim;
        rope.aimX *= k; rope.aimY *= k;
        rope.tx = rope.aimX; rope.ty = rope.aimY;
        break;
      }
      const [hr, hc] = path[path.length - 1];
      rope.edge = { r: best[0], c: best[1], back: best[2],
                    dr: best[0] - hr, dc: best[1] - hc };
      rope.s = 0;
      dx = rope.aimX; dy = rope.aimY;            // spend what chose the way along it
      rope.aimX = rope.aimY = 0;
      continue;
    }

    const e = rope.edge;
    const ux = dx / len, uy = dy / len;
    const cos = ux * e.dc + uy * e.dr;
    let along = len * cos;
    // Barely started down one way while the finger plainly wants another, as
    // when momentum carries the head a hair into the straight-on branch of a
    // fork: it slides back to the middle of the cell and takes the other.
    let turning = false;
    if (cos < 0.3 && rope.s < 0.5) {
      const alt = choose(ux, uy);
      if (alt && (alt[0] !== e.r || alt[1] !== e.c)) { along = -len; turning = true; }
    }
    if (!turning) {                // the sideways part is tension
      rope.tx += dx - e.dc * along; rope.ty += dy - e.dr * along;
    }
    rope.s += along / step;
    dx = dy = 0;
    if (rope.s >= 1) {                           // arrived: the trail takes the step
      const over = (rope.s - 1) * step;
      if (e.back) retreat(); else advance(e.r, e.c);
      rope.edge = null; rope.s = 0;
      travelling = true;
      dx = ux * over; dy = uy * over;
    } else if (rope.s < 0) {                     // back on the head's own cell
      const under = -rope.s * step;
      rope.edge = null; rope.s = 0;
      if (turning) { dx = ux * under; dy = uy * under; travelling = true; }
      else { dx = -e.dc * under; dy = -e.dr * under; }
    }
  }
  const t = Math.hypot(rope.tx, rope.ty), cap = step * 0.5;
  if (t > cap) { rope.tx *= cap / t; rope.ty *= cap / t; }
}

function resetPath() {
  ropeReset();
  path = [];
  seen = new Map();
  won = false;
  celebrated = false;
  drawing = false;
  pending = null;
  clearTimeout(cheerTimer);
  cheer.hidden = true;
  nextBtn.classList.remove('ready');
  drawInk();
}

/* ------------------------------------------------------------------ undo */

// A gesture that went wrong should cost the gesture, not the run. The trail is
// photographed whenever a finger goes down and the picture kept if the gesture
// changed anything, so Undo can hand back the trail as it stood before it.
const UNDO_MAX = 24;

const head = (t) => (t.length ? t[t.length - 1] : null);
const sameTrail = (a, b) =>
  a.length === b.length && (!a.length || (head(a)[0] === head(b)[0] && head(a)[1] === head(b)[1]));

function keep(trail) {
  if (!trail || sameTrail(trail, path)) return;   // nothing moved: nothing to undo
  history.push(trail);
  if (history.length > UNDO_MAX) history.shift();
  undoBtn.disabled = false;
}

function forget() {
  history = [];
  undoBtn.disabled = true;
}

function undo() {
  if (!history.length) return;
  ropeReset();
  path = history.pop();
  seen = new Map();
  for (let i = 0; i < path.length; i++) seen.set(key(path[i][0], path[i][1]), i);
  won = path.length > 0 && head(path)[0] === maze.end[0] && head(path)[1] === maze.end[1];
  celebrated = won;              // a winning trail restored has been cheered already
  drawing = false;
  pending = null;
  clearTimeout(cheerTimer);
  cheer.hidden = true;
  if (won) nextBtn.classList.add('ready');
  else nextBtn.classList.remove('ready');
  undoBtn.disabled = history.length === 0;
  drawInk();
  saveTrail();
}

/* -------------------------------------------------------------- pointers */

// The finger can be anywhere on the board: it holds the end of the string,
// not the head itself, so it never covers the cells it is steering into.

// One cell of pull per cell moved, but never less than a fingertip's nudge,
// so on the smallest cells a tremor is still not a step.
const stepPx = () => Math.max(cell, 16);

inkCanvas.addEventListener('pointerdown', (e) => {
  pending = path.slice();
  if (path.length === 0) {
    advance(maze.start[0], maze.start[1]);   // the string starts at the start animal
    pulseStart();
  }
  drawing = true;
  rope.aimX = rope.aimY = 0;
  lastX = e.clientX; lastY = e.clientY;
  inkCanvas.setPointerCapture(e.pointerId);
  drawInk();
  if (won) celebrate();
  e.preventDefault();
});

inkCanvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const before = path.length, stood = path[path.length - 1];
  // Every sample since the last frame, in order, so a quick swirl round a
  // corner pulls round the corner rather than straight across it.
  const samples = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
  for (const s of samples.length ? samples : [e]) {
    slide(s.clientX - lastX, s.clientY - lastY, stepPx());
    lastX = s.clientX; lastY = s.clientY;
  }
  // Redrawn on every move, not only when the head changes cell: the pull on
  // the string shows in the head's shape.
  drawInk();
  if (won && (path.length !== before || path[path.length - 1] !== stood)) celebrate();
  e.preventDefault();
});

for (const type of ['pointerup', 'pointercancel']) {
  inkCanvas.addEventListener(type, (e) => {
    const wasDrawing = drawing;
    drawing = false;
    rope.tx = rope.ty = rope.aimX = rope.aimY = 0;
    if (wasDrawing) drawInk();       // the head springs back round, but stays where it slid to
    keep(pending);
    pending = null;
    saveTrail();
    guard();
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
  document.getElementById('cheer-mark').textContent = endMarkOf(maze);
  cheer.hidden = false;
  nextBtn.classList.add('ready');
  // Take the card away again so he can admire the path he drew; the glowing
  // Next button is what carries on saying well done.
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => { cheer.hidden = true; }, 2600);
  confetti();
  if (!endless) save();
  else save();
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const glyphs = [maze.startMark, endMarkOf(maze), ...T().confetti];
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
  // A newer app arrived while he was playing. Between two mazes is the moment
  // to take it: the progress is already saved and there is no trail to lose.
  if (stale) { location.reload(); return; }

  maze = new Maze(data);
  current = data;
  resetPath();
  forget();               // a new maze: there is no earlier trail to go back to
  fit();
  drawWalls();
  restoreTrail();         // the run he was in the middle of, if this is its maze
  drawInk();
  saveTrail();

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
    cols: Math.min(30, Math.max(5, Math.floor((stage.clientWidth - SIDE() * 2) / target))),
  };
}

function nextMaze() {
  if (endless) {
    // Coming back to endless mode with a run half done: that maze, not a new one.
    if (resume && resume.endless && resume.board && resume.wins === endlessWins) {
      show(resume.board);
      return;
    }
    const { rows, cols } = endlessShape();
    show(JSON.parse(window.mazeGenerate(rows, cols, Math.floor(Math.random() * 2 ** 53), 14)));
    return;
  }
  level++;
  if (level >= pack.length) {
    level = pack.length - 1;   // stay on the last, so switching back has one to show
    if (wasmReady) { setEndless(true); return; }   // pack finished: keep going
    level = 0;                                     // no wasm: round again
  }
  save();
  show(pack[level]);
}

function setEndless(on) {
  endless = on && wasmReady;
  level = Math.min(Math.max(level, 0), pack.length - 1);
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

// The trail is kept too, so a maze closed halfway — an edge swipe, a phone
// call, the app killed in the background — opens again where he left it.
// Endless mazes are random, so for those the maze goes with it.
function saveTrail() {
  if (!maze) return;
  try {
    localStorage.setItem(TRAIL_KEY, JSON.stringify({
      endless, level, wins: endlessWins,
      board: endless ? current : null,
      path,
    }));
  } catch (_) { /* private browsing: the trail just won't survive a restart */ }
}

function loadTrail() {
  try {
    return JSON.parse(localStorage.getItem(TRAIL_KEY));
  } catch (_) { return null; }
}

// restoreTrail puts back the saved trail if it belongs to the maze just
// shown, and only if it is still a legal walk on it: a stale or damaged save
// must cost a trail, never break the maze.
function restoreTrail() {
  const t = resume;
  if (!t || t.endless !== endless) return;
  if (endless ? t.board !== current : t.level !== level) return;
  resume = null;

  const p = Array.isArray(t.path) ? t.path : [];
  if (!p.length || p[0][0] !== maze.start[0] || p[0][1] !== maze.start[1]) return;
  const s = new Map();
  for (let i = 0; i < p.length; i++) {
    const [r, c] = p[i];
    if (!maze.inside(r, c) || s.has(key(r, c))) return;
    if (i && !maze.linked(p[i - 1][0], p[i - 1][1], r, c)) return;
    s.set(key(r, c), i);
  }
  path = p.map(([r, c]) => [r, c]);
  seen = s;
  settle();
  celebrated = won;          // already cheered (and counted) before he left
  if (won) nextBtn.classList.add('ready');
}

// The back swipe. Once there is a trail worth keeping, an extra history entry
// sits on top of the page, so a swipe in from the edge only pops that entry
// and the maze stays put. It is added after a finger lifts because browsers
// ignore entries a page pushes without the user having touched it.
function guard() {
  if (guarded || path.length < 2 || !window.history || !window.history.pushState) return;
  try {
    window.history.pushState({ maze: true }, '');
    guarded = true;
  } catch (_) { /* some embedded webviews refuse: the saved trail still holds */ }
}

window.addEventListener('popstate', () => {
  guarded = false;
  guard();                   // still mid-maze: put the guard straight back
});

// Save on the way out as well, in case the app goes mid-drag.
window.addEventListener('pagehide', saveTrail);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveTrail();
});

/* ---------------------------------------------------------- fresh start */

// The way out of anything that has gone wrong for good: forget where he had
// got to, throw away every file the browser is holding on our behalf, and come
// back for the whole app again. Wired to the small faint button in the line of
// numbers, and it asks first, because there is no undoing this one.
function wipe() {
  if (!confirm('Start again from scratch?\n\n'
             + 'This forgets which maze you are on and downloads the app afresh.')) return;

  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(TRAIL_KEY);
  } catch (_) { /* nothing was saved anyway */ }

  // The cached copies, then the worker that serves them. Both are allowed to
  // fail: coming back for a fresh page is worth having either way, so the
  // reload happens whatever these two make of it.
  const jobs = [];
  if (typeof caches !== 'undefined') {
    jobs.push(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
  if (navigator.serviceWorker) {
    jobs.push(navigator.serviceWorker.getRegistration().then((reg) => reg && reg.unregister()));
  }
  const reload = () => location.reload();
  Promise.all(jobs.map((p) => p.catch(() => {}))).then(reload, reload);
}

/* ------------------------------------------------------------- controls */

// Again is a single tap away from a long run, so it is undoable as well.
document.getElementById('reset').addEventListener('click', () => {
  const was = path.slice();
  resetPath();
  keep(was);
  saveTrail();
});
undoBtn.addEventListener('click', undo);
// Next always moves on, in endless mode too: the count and the shrinking cells
// follow every maze left behind, so a skip is seen to do something rather
// than handing over another "Maze 1" the same size.
nextBtn.addEventListener('click', () => {
  resume = null;
  if (endless) endlessWins++;
  nextMaze();
});
document.getElementById('wipe').addEventListener('click', wipe);

endlessBtn.addEventListener('click', () => setEndless(!endless));

themeBtn.addEventListener('click', () => {
  themeName = themeName === 'magic' ? 'classic' : 'magic';
  try { localStorage.setItem(THEME_KEY, themeName); } catch (_) { /* fine */ }
  applyTheme();
  if (maze) { drawWalls(); drawInk(); }      // same maze, same trail, new colours
});

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
    endlessBtn.hidden = false;          // there is now something to switch to
    if (wantEndless) setEndless(true);  // he was in endless mode when he left
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
    wantEndless = Boolean(saved.endless);
    resume = loadTrail();
    show(pack[level]);
    loadWasm();
  })
  .catch(() => {
    document.getElementById('level').textContent = 'Could not load pack.json';
  });

// The worker serves the app from a cache, so a page can go on running the
// version it was launched with long after a new one is sitting there installed.
// A worker taking over is the signal that has happened, and the only way to see
// the new files is to go back for the page: at once if he has not started, and
// otherwise at the next maze, where there is nothing to lose by it.
// Only our own worker counts. Embedded in another page (a preview, say) the
// frame can be under someone else's worker, and its comings and goings must
// not send the maze back to the start on every Next.
const ourWorker = (w) => Boolean(w && /\/sw\.js$/.test(w.scriptURL));
try {
  if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window) {
    const updating = ourWorker(navigator.serviceWorker.controller);  // not a first visit
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updating) return;      // the first worker ever, claiming its first page
      if (!ourWorker(navigator.serviceWorker.controller)) return;
      stale = true;
      if (!path.length) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
} catch (_) { /* a sandboxed frame may refuse to say: then there is no worker */ }
