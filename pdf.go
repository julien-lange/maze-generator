//go:build !(js && wasm)

package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"strings"
)

// Printing a pack. A maze is a few hundred straight lines and two short strings
// of text, which is about the least a PDF can be asked to hold, so this writes
// one by hand rather than pulling in a dependency: a handful of objects, one
// content stream per sheet, and a table of byte offsets.
//
// The pages are drawn from the pack itself, not from a second generation run,
// so a printed maze is the very same maze as the one on the phone — same tiers,
// same ramp, same seed, same walls.

// A4 in PostScript points, which are 1/72 inch.
const (
	pageWidth  = 595.28
	pageHeight = 841.89
	pageMargin = 48.0

	headerHeight = 44.0 // title and stars
	footerHeight = 26.0 // the measurements line
	maxCellPt    = 80.0 // ~28mm: generous for a small hand, and stops the first
	//                    tiny mazes stretching to a whole sheet of enormous cells
)

// unpackBits is packBits inverted. Reconstructing the walls from the base64 the
// browser reads is what guarantees the sheet and the screen show the same maze.
func unpackBits(s string, walls [][]bool) error {
	buf, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return err
	}
	i := 0
	for r := range walls {
		for c := range walls[r] {
			if i/8 >= len(buf) {
				return errors.New("bitset is short")
			}
			walls[r][c] = buf[i/8]&(1<<(i%8)) != 0
			i++
		}
	}
	return nil
}

// maze rebuilds the graph a wire entry describes.
func (w wire) maze() (*Maze, error) {
	m := New(w.Rows, w.Cols)
	if err := unpackBits(w.East, m.east); err != nil {
		return nil, fmt.Errorf("east walls: %w", err)
	}
	if err := unpackBits(w.South, m.south); err != nil {
		return nil, fmt.Errorf("south walls: %w", err)
	}
	return m, nil
}

// pdfDoc collects numbered objects and serialises them with an xref table.
type pdfDoc struct{ objs [][]byte }

// reserve claims an object number to be filled in later, which the catalogue
// and the page tree both need: they refer to objects written after them.
func (d *pdfDoc) reserve() int {
	d.objs = append(d.objs, nil)
	return len(d.objs)
}

func (d *pdfDoc) set(num int, body string) { d.objs[num-1] = []byte(body) }

func (d *pdfDoc) add(body string) int {
	n := d.reserve()
	d.set(n, body)
	return n
}

func (d *pdfDoc) addStream(content string) int {
	return d.add(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
}

// addBinaryStream is addStream for data that is not text — the emoji images —
// so it never goes near a %s format verb.
func (d *pdfDoc) addBinaryStream(entries string, data []byte) int {
	var b bytes.Buffer
	fmt.Fprintf(&b, "<< %s /Length %d >>\nstream\n", entries, len(data))
	b.Write(data)
	b.WriteString("\nendstream")

	n := d.reserve()
	d.objs[n-1] = b.Bytes()
	return n
}

func (d *pdfDoc) Bytes() []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")

	offsets := make([]int, len(d.objs))
	for i, body := range d.objs {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}

	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n", len(d.objs)+1)
	b.WriteString("0000000000 65535 f \n")
	for _, off := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n",
		len(d.objs)+1, xref)
	return b.Bytes()
}

// pdfText escapes a string for a PDF literal and maps the few non-ASCII
// characters the measurements line uses onto WinAnsiEncoding, which the built-in
// Helvetica understands without anything being embedded.
func pdfText(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '(', ')', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '·':
			b.WriteString("\\267")
		case '×':
			b.WriteString("\\327")
		case ' ': // the info line's hard spaces
			b.WriteByte(' ')
		default:
			if r < 128 {
				b.WriteRune(r)
			} else {
				b.WriteByte('?')
			}
		}
	}
	return b.String()
}

// circle approximates one with four Béziers; PDF has no arc operator.
func circle(b *strings.Builder, cx, cy, r float64) {
	const k = 0.5523 // control-point distance that fits a circle to within ~0.02%
	fmt.Fprintf(b, "%.2f %.2f m ", cx+r, cy)
	fmt.Fprintf(b, "%.2f %.2f %.2f %.2f %.2f %.2f c ", cx+r, cy+r*k, cx+r*k, cy+r, cx, cy+r)
	fmt.Fprintf(b, "%.2f %.2f %.2f %.2f %.2f %.2f c ", cx-r*k, cy+r, cx-r, cy+r*k, cx-r, cy)
	fmt.Fprintf(b, "%.2f %.2f %.2f %.2f %.2f %.2f c ", cx-r, cy-r*k, cx-r*k, cy-r, cx, cy-r)
	fmt.Fprintf(b, "%.2f %.2f %.2f %.2f %.2f %.2f c ", cx+r*k, cy-r, cx+r, cy-r*k, cx+r, cy)
}

// star draws a five-pointed star, used for the difficulty rating.
func star(b *strings.Builder, cx, cy, r float64) {
	for i := range 10 {
		rr := r
		if i%2 == 1 {
			rr = r * 0.42
		}
		a := -math.Pi/2 + float64(i)*math.Pi/5
		op := "l"
		if i == 0 {
			op = "m"
		}
		fmt.Fprintf(b, "%.2f %.2f %s ", cx+rr*math.Cos(a), cy+rr*math.Sin(a), op)
	}
	b.WriteString("h ")
}

// pdfPage draws one maze on one sheet: a heading with its difficulty in stars,
// the maze, and the same line of measurements the player shows under the board.
func pdfPage(w wire, index, total int, pool *emojiPool) (string, []int, error) {
	m, err := w.maze()
	if err != nil {
		return "", nil, err
	}

	var b strings.Builder
	b.WriteString("1 J 1 j\n") // round caps and joins, as on screen

	// Heading, left, with the stars ranged right.
	fmt.Fprintf(&b, "BT /F2 15 Tf 0 g %.2f %.2f Td (%s) Tj ET\n",
		pageMargin, pageHeight-pageMargin-11,
		pdfText(fmt.Sprintf("Maze %d of %d", index+1, total)))
	for i := range 5 {
		cx := pageWidth - pageMargin - 8 - float64(4-i)*20
		cy := pageHeight - pageMargin - 6
		star(&b, cx, cy, 8)
		if i < w.Stars {
			b.WriteString("0.15 g f\n")
		} else {
			b.WriteString("0.6 G 0.8 w S\n")
		}
	}

	// The maze fills what is left, at whole points, capped so the small early
	// mazes do not end up with enormous cells.
	availW := pageWidth - 2*pageMargin
	availH := pageHeight - 2*pageMargin - headerHeight - footerHeight
	cell := math.Min(math.Min(availW/float64(m.Cols), availH/float64(m.Rows)), maxCellPt)
	mazeW, mazeH := cell*float64(m.Cols), cell*float64(m.Rows)
	x0 := (pageWidth - mazeW) / 2
	y0 := pageMargin + footerHeight + (availH-mazeH)/2

	// PDF measures y upwards, so row i's top edge is mazeH - i*cell above y0.
	top := func(row int) float64 { return y0 + mazeH - float64(row)*cell }
	left := func(col int) float64 { return x0 + float64(col)*cell }

	// Faint: enough to find the two cells on a black-and-white print, not so much
	// that it draws a box round the animal standing in it.
	shade := func(c Cell) {
		fmt.Fprintf(&b, "0.93 g %.2f %.2f %.2f %.2f re f\n",
			left(c.Col), top(c.Row+1), cell, cell)
	}
	shade(Cell{0, 0})
	shade(Cell{m.Rows - 1, m.Cols - 1})

	// The same two animals as on screen, as images. The fallbacks — a dot for the
	// start, a target for the end — keep the booklet printable if assets/emoji
	// has not been built.
	var used []int
	mark := func(c Cell, glyph string, fallback func(cx, cy float64)) {
		cx, cy := left(c.Col)+cell/2, top(c.Row+1)+cell/2
		num, ok := pool.ref(glyph)
		if !ok {
			fallback(cx, cy)
			return
		}
		size := cell * 0.72
		fmt.Fprintf(&b, "q %.2f 0 0 %.2f %.2f %.2f cm /Im%d Do Q\n",
			size, size, cx-size/2, cy-size/2, num)
		used = append(used, num)
	}

	mark(Cell{0, 0}, w.StartMark, func(cx, cy float64) {
		circle(&b, cx, cy, cell*0.17)
		b.WriteString("0.15 g f\n")
	})
	mark(Cell{m.Rows - 1, m.Cols - 1}, w.EndMark, func(cx, cy float64) {
		circle(&b, cx, cy, cell*0.28)
		fmt.Fprintf(&b, "0.15 G %.2f w S\n", math.Max(cell*0.06, 0.8))
		circle(&b, cx, cy, cell*0.11)
		b.WriteString("0.15 g f\n")
	})

	// The walls, exactly as print.go and the player decide them: a wall is a
	// missing edge, and off-grid queries report closed, so the boundary needs no
	// special case.
	fmt.Fprintf(&b, "0 G %.2f w\n", math.Max(cell*0.09, 1.1))
	for i := 0; i <= m.Rows; i++ {
		for j := range m.Cols {
			if !m.OpenSouth(i-1, j) {
				fmt.Fprintf(&b, "%.2f %.2f m %.2f %.2f l S\n", left(j), top(i), left(j+1), top(i))
			}
		}
	}
	for j := 0; j <= m.Cols; j++ {
		for i := range m.Rows {
			if !m.OpenEast(i, j-1) {
				fmt.Fprintf(&b, "%.2f %.2f m %.2f %.2f l S\n", left(j), top(i), left(j), top(i+1))
			}
		}
	}

	// The same measurements the screen shows, for the same reason.
	info := fmt.Sprintf("#%d/%d · %d×%d · %s · %d steps · %d junctions · score %d",
		index+1, total, w.Rows, w.Cols, w.Algo, w.Steps, w.Junctions, w.Score)
	fmt.Fprintf(&b, "BT /F1 8 Tf 0.45 g %.2f %.2f Td (%s) Tj ET\n",
		pageMargin, pageMargin, pdfText(info))

	return b.String(), used, nil
}

// PDF renders a whole pack as an A4 booklet, one maze to a sheet.
func PDF(p packFile) ([]byte, error) {
	d := &pdfDoc{}
	catalog := d.reserve()
	pages := d.reserve()
	helv := d.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
	bold := d.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")

	pool := newEmojiPool(d)
	kids := make([]string, 0, len(p.Mazes))
	for i, w := range p.Mazes {
		content, images, err := pdfPage(w, i, len(p.Mazes), pool)
		if err != nil {
			return nil, fmt.Errorf("maze %d: %w", i+1, err)
		}

		xobjects := ""
		if len(images) > 0 {
			var names []string
			for _, num := range images {
				names = append(names, fmt.Sprintf("/Im%d %d 0 R", num, num))
			}
			xobjects = fmt.Sprintf(" /XObject << %s >>", strings.Join(names, " "))
		}

		stream := d.addStream(content)
		page := d.add(fmt.Sprintf(
			"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f ] "+
				"/Resources << /Font << /F1 %d 0 R /F2 %d 0 R >>%s >> /Contents %d 0 R >>",
			pages, pageWidth, pageHeight, helv, bold, xobjects, stream))
		kids = append(kids, fmt.Sprintf("%d 0 R", page))
	}

	d.set(catalog, fmt.Sprintf("<< /Type /Catalog /Pages %d 0 R >>", pages))
	d.set(pages, fmt.Sprintf("<< /Type /Pages /Kids [ %s ] /Count %d >>",
		strings.Join(kids, " "), len(kids)))
	return d.Bytes(), nil
}
