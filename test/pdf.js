'use strict';

// Checks a printed pack. The PDF is written by hand in pdf.go, so this verifies
// the things a hand-written PDF gets wrong — xref offsets, page count, page
// tree — and then that each sheet actually carries the maze it claims to: the
// number of wall segments drawn is checked against the size in its own footer.
//
// Deliberately self-contained: it reads nothing but the PDF, so it does not
// care which flags the pack was built with.

const fs = require('fs');
const { results } = require('./harness');

const file = process.argv[2] || 'mazes.pdf';
const r = results('PDF CHECKS');

if (!fs.existsSync(file)) {
  console.log(`FAIL: ${file} does not exist (run: make pdf)`);
  process.exit(1);
}
const buf = fs.readFileSync(file, 'latin1');

// 1. It must look like a PDF at both ends.
if (!buf.startsWith('%PDF-1.')) r.fail('does not start with a %PDF header');
if (!buf.trimEnd().endsWith('%%EOF')) r.fail('does not end with %%EOF');

// 2. The xref table must point at the objects it claims to. This is the part a
//    hand-rolled writer gets wrong, and every reader relies on it.
const sx = /startxref\s+(\d+)/.exec(buf);
if (!sx) {
  r.fail('no startxref');
} else {
  const table = buf.slice(Number(sx[1]));
  if (!table.startsWith('xref')) r.fail('startxref does not point at the xref table');
  const head = /^xref\s+0\s+(\d+)\s/.exec(table);
  if (!head) {
    r.fail('malformed xref header');
  } else {
    const count = Number(head[1]);
    const entries = [...table.matchAll(/(\d{10}) (\d{5}) ([nf])/g)];
    if (entries.length !== count) r.fail(`xref declares ${count} objects, lists ${entries.length}`);
    for (let i = 1; i < entries.length; i++) {
      const off = Number(entries[i][1]);
      const want = `${i} 0 obj`;
      if (buf.slice(off, off + want.length) !== want) {
        r.fail(`xref entry ${i} points at "${buf.slice(off, off + 12)}", want "${want}"`);
      }
    }
  }
}

// 3. The page tree must agree with the pages actually present.
const declared = /\/Count (\d+)/.exec(buf);
const pageObjs = [...buf.matchAll(/\/Type \/Page[^s]/g)].length;
const kids = /\/Kids \[([^\]]*)\]/.exec(buf);
if (!declared) r.fail('no /Count in the page tree');
else if (Number(declared[1]) !== pageObjs) r.fail(`/Count says ${declared[1]}, found ${pageObjs} pages`);
if (!kids) r.fail('no /Kids array');
else if (kids[1].trim().split(/\s+0\s+R/).filter(Boolean).length !== pageObjs) {
  r.fail('/Kids does not list every page');
}
if ([...buf.matchAll(/\/MediaBox \[0 0 595\.28 841\.89 \]/g)].length !== pageObjs) {
  r.fail('not every page is A4');
}

// 4. Every content stream must declare its true length.
const streams = [...buf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
if (streams.length !== pageObjs) r.fail(`${streams.length} content streams for ${pageObjs} pages`);
for (const [i, s] of streams.entries()) {
  if (Number(s[1]) !== s[2].length) r.fail(`page ${i + 1}: /Length ${s[1]}, stream is ${s[2].length}`);
}

// 5. Each sheet must draw the maze its own footer describes. \267 and \327 are
//    the middle dot and multiplication sign in WinAnsiEncoding.
const info = new RegExp(
  '#(\\d+)/(\\d+) \\\\267 (\\d+)\\\\327(\\d+) \\\\267 (\\w+) \\\\267 ' +
  '(\\d+) steps \\\\267 (\\d+) junctions \\\\267 score (\\d+)');

const seen = [];
for (const [i, s] of streams.entries()) {
  const page = s[2];
  const m = info.exec(page);
  if (!m) {
    r.fail(`page ${i + 1}: no measurements line`);
    continue;
  }
  const [, idx, total, rows, cols, algo, steps, junctions, score] = m;
  const n = Number;

  if (n(idx) !== i + 1) r.fail(`page ${i + 1} is labelled #${idx}`);
  if (n(total) !== pageObjs) r.fail(`page ${i + 1} says the pack has ${total} mazes, not ${pageObjs}`);
  if (!['prim', 'dfs'].includes(algo)) r.fail(`page ${i + 1}: unknown algorithm "${algo}"`);
  if (n(score) !== n(steps) + 3 * n(junctions)) r.fail(`page ${i + 1}: score is not steps + 3*junctions`);

  // The drawn walls must match the grid in the footer: every cell boundary is a
  // segment, less the passages a spanning tree opens.
  const want = n(rows) * (n(cols) + 1) + n(cols) * (n(rows) + 1) - (n(rows) * n(cols) - 1);
  const drawn = (page.match(/ l S/g) || []).length;
  if (drawn !== want) r.fail(`page ${i + 1} (${rows}x${cols}): drew ${drawn} wall segments, want ${want}`);

  if (!page.includes(`(Maze ${i + 1} of ${total}) Tj`)) r.fail(`page ${i + 1}: heading missing or wrong`);

  // Both animals must be placed as images. Falling back to the plain dot and
  // target is legal but silent, so it needs catching.
  const placed = (page.match(/\/Im\d+ Do/g) || []).length;
  if (placed !== 2) r.fail(`page ${i + 1}: placed ${placed} animal images, want 2`);
  seen.push({ rows: n(rows), cols: n(cols), algo });
}

// 6. The animal images: each glyph is a colour image plus a soft mask carrying
//    its transparency, embedded once however many sheets use it.
const images = [...buf.matchAll(/\/Subtype \/Image/g)].length;
const masks = [...buf.matchAll(/\/SMask \d+ 0 R/g)].length;
if (images === 0) r.fail('no animal images were embedded at all');
if (images !== masks * 2) r.fail(`${images} images for ${masks} soft masks; want two per mask`);
if ([...buf.matchAll(/\/XObject <</g)].length !== pageObjs) {
  r.fail('not every page declares its images in /Resources');
}

// 7. The printed pack must ramp like the played one: the grid never shrinks.
for (let i = 1; i < seen.length; i++) {
  if (seen[i].rows < seen[i - 1].rows || seen[i].cols < seen[i - 1].cols) {
    r.fail(`grid shrinks at page ${i + 1}`);
  }
}
if (new Set(seen.map((s) => s.algo)).size !== 2) r.fail('the printed pack uses only one generator');

const sizes = seen.length ? `${seen[0].rows}x${seen[0].cols} .. ${seen.at(-1).rows}x${seen.at(-1).cols}` : '-';
r.done(
  `${pageObjs} A4 pages, ${sizes}, ${(buf.length / 1024).toFixed(0)} KB`,
);
