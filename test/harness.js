'use strict';

// Shared plumbing. The point of all three suites is to exercise the files that
// actually get published, not a copy of them, so everything here reads out of
// docs/ rather than reimplementing anything.

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');

const read = (name) => fs.readFileSync(path.join(DOCS, name), 'utf8');
const readPack = () => JSON.parse(read('pack.json'));

// loadLogic lifts the DOM-free half of app.js — the maze decoder and the path
// walker — into a module. Slicing the real file rather than copying it is what
// keeps these tests honest: there is no second set of walking rules to drift
// out of step with the one the phone runs.
function loadLogic() {
  const src = read('app.js');
  const slice = (from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to);
    if (a < 0 || b < 0) throw new Error(`harness: section markers moved in app.js (${from} .. ${to})`);
    return src.slice(a, b);
  };

  const code =
    'var maze, path = [], seen = new Map(), won = false;\n' +
    slice('function decodeBits', '/* ----------------------------------------------------------------- state */') +
    slice('const key = (r, c)', '/* -------------------------------------------------------------- pointers */') +
    '\nmodule.exports = { Maze, advance, walkTowards,' +
    ' set: (m) => { maze = m; },' +
    ' reset: () => { path = []; seen = new Map(); won = false; },' +
    ' state: () => ({ path, won }) };';

  const mod = new (require('module'))();
  mod._compile(code, path.join(DOCS, 'app-logic.js'));
  return mod.exports;
}

// degree counts the ways out of a cell. The suites recompute junctions with it
// so the numbers Go ships for display are checked against the maze itself
// rather than taken on trust.
const degree = (m, r, c) =>
  (m.openEast(r, c) ? 1 : 0) + (m.openEast(r, c - 1) ? 1 : 0) +
  (m.openSouth(r, c) ? 1 : 0) + (m.openSouth(r - 1, c) ? 1 : 0);

// results collects failures so every suite reports and exits the same way.
function results(label) {
  let fails = 0;
  return {
    fail(msg) { console.log('FAIL:', msg); fails++; },
    get failed() { return fails; },
    done(...lines) {
      for (const line of lines) console.log(line);
      console.log(fails === 0 ? `${label} PASSED` : `${label}: ${fails} FAILURES`);
      process.exit(fails === 0 ? 0 : 1);
    },
  };
}

module.exports = { DOCS, read, readPack, loadLogic, degree, results };
