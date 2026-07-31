package main

import (
	"bufio"
	"fmt"
	"math/rand/v2"
	"strings"
)

// A4 at 10pt monospace with ~2cm margins fits roughly this much text.
const (
	pageCols = 80
	pageRows = 60
)

// layout is everything the printer needs beyond the maze itself.
type layout struct {
	CellW  int // interior width of one cell, in characters
	Labels bool
	Style  style

	Start, End Cell   // the cells to mark
	StartMark  string // animal emoji drawn in the start cell
	EndMark    string // and in the end cell

	labelW int // width of a row label, derived in Print
	lead   int // width of the whole row-label gutter
}

// emojiWidth is how many columns an emoji takes up in a monospace grid. The
// animals below are all East Asian Wide, so they are two columns each even
// though they are a single rune, and padding has to be counted accordingly.
const emojiWidth = 2

// animals are the markers available for the start and end cells. All are wide
// by default, with no variation selector needed, so none of them collapse to a
// single column in a terminal.
var animals = []string{
	"🐭", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸",
	"🐵", "🐔", "🦉", "🐺", "🐗", "🐴", "🦄", "🐢", "🐙", "🦀",
	"🐬", "🐳", "🦈", "🐊", "🦓", "🐘", "🦏", "🐫", "🦒", "🐕",
	"🐈", "🦌", "🐇", "🦔", "🐝", "🦋", "🐞", "🐌", "🐧", "🦆",
}

// AnimalPair picks two different animals to stand at the two ends of the maze.
func AnimalPair(rng *rand.Rand) (start, end string) {
	i := rng.IntN(len(animals))
	j := (i + 1 + rng.IntN(len(animals)-1)) % len(animals) // anything but i
	return animals[i], animals[j]
}

// interior renders the inside of one cell: blank, or an animal centred in it.
// A cell narrower than an emoji is left blank rather than overflowing and
// shearing every column to its right.
func (o layout) interior(c Cell) string {
	mark := ""
	switch c {
	case o.Start:
		mark = o.StartMark
	case o.End:
		mark = o.EndMark
	}
	if mark == "" || o.CellW < emojiWidth {
		return strings.Repeat(" ", o.CellW)
	}
	left := (o.CellW - emojiWidth) / 2
	return strings.Repeat(" ", left) + mark + strings.Repeat(" ", o.CellW-emojiWidth-left)
}

// style is the character set used to draw the walls.
type style struct {
	hbar, vbar rune
	// junction picks the character where wall segments meet, given which of the
	// four directions carry a wall.
	junction func(up, right, down, left bool) rune
}

// boxChars is indexed by up + 2*right + 4*down + 8*left.
var boxChars = [16]rune{
	' ', '╵', '╶', '└', '╷', '│', '┌', '├',
	'╴', '┘', '─', '┴', '┐', '┤', '┬', '┼',
}

func styleFor(unicode bool) style {
	if unicode {
		return style{hbar: '─', vbar: '│', junction: func(up, right, down, left bool) rune {
			i := 0
			for k, set := range []bool{up, right, down, left} {
				if set {
					i |= 1 << k
				}
			}
			return boxChars[i]
		}}
	}
	return style{hbar: '-', vbar: '|', junction: func(up, right, down, left bool) rune {
		if up || right || down || left {
			return '+'
		}
		return ' '
	}}
}

// The printer works in wall coordinates, which run one past the cells: the wall
// above row i is drawn on line i, and there are Rows+1 such lines. A wall is
// simply a missing edge, and OpenEast/OpenSouth report false off the grid, so
// the boundary comes out closed without a special case.

// wallAbove reports whether a wall separates row-1 from row, at the given column.
func wallAbove(m *Maze, row, col int) bool { return !m.OpenSouth(row-1, col) }

// wallLeft reports whether a wall separates col-1 from col, in the given row.
func wallLeft(m *Maze, row, col int) bool { return !m.OpenEast(row, col-1) }

// Print writes the maze laid out for A4: mazes too wide for a sheet are split
// into vertical blocks, mazes too tall into row chunks, and each piece is
// separated by a form feed so a printer breaks cleanly.
func Print(w *bufio.Writer, m *Maze, o layout) {
	if o.Labels {
		o.labelW = len(fmt.Sprint(max(m.Rows, m.Cols) - 1))
		o.lead = o.labelW + 1
	}

	// A block of c cells is 1 + c*(CellW+1) characters wide: a junction column
	// before every cell, plus one to close the last cell.
	perBlock := max((pageCols-o.lead-1)/(o.CellW+1), 1)
	// Every row costs 2 lines (its top wall and its body), plus one line for the
	// maze's bottom wall, one column header, and a blank line plus a footer.
	perPage := max((pageRows-4)/2, 1)

	first := true
	for c0 := 0; c0 < m.Cols; c0 += perBlock {
		c1 := min(c0+perBlock, m.Cols)
		for r0 := 0; r0 < m.Rows; r0 += perPage {
			r1 := min(r0+perPage, m.Rows)
			if !first {
				w.WriteString("\f") // form feed: new sheet of paper
			}
			first = false
			page(w, m, o, r0, r1, c0, c1)
		}
	}
}

// page draws rows [r0,r1) and columns [c0,c1) as one sheet. Walls outside that
// window are ignored, so junctions on a cut edge do not sprout stubs pointing
// off the page.
func page(w *bufio.Writer, m *Maze, o layout, r0, r1, c0, c1 int) {
	hseg := func(row, col int) bool { return col >= c0 && col < c1 && wallAbove(m, row, col) }
	vseg := func(row, col int) bool { return row >= r0 && row < r1 && wallLeft(m, row, col) }

	// wallLine draws the horizontal walls above row i.
	wallLine := func(i int) {
		w.WriteString(strings.Repeat(" ", o.lead))
		for j := c0; j <= c1; j++ {
			w.WriteRune(o.Style.junction(vseg(i-1, j), hseg(i, j), vseg(i, j), hseg(i, j-1)))
			if j < c1 {
				bar := ' '
				if wallAbove(m, i, j) {
					bar = o.Style.hbar
				}
				w.WriteString(strings.Repeat(string(bar), o.CellW))
			}
		}
		w.WriteString("\n")
	}

	// bodyLine draws the vertical walls of row i and the open cells between them.
	bodyLine := func(i int) {
		if o.Labels {
			fmt.Fprintf(w, "%*d ", o.labelW, i)
		}
		for j := c0; j <= c1; j++ {
			if wallLeft(m, i, j) {
				w.WriteRune(o.Style.vbar)
			} else {
				w.WriteRune(' ')
			}
			if j < c1 {
				w.WriteString(o.interior(Cell{i, j}))
			}
		}
		w.WriteString("\n")
	}

	if o.Labels {
		w.WriteString(strings.Repeat(" ", o.lead+1))
		for j := c0; j < c1; j++ {
			fmt.Fprintf(w, "%s ", center(fmt.Sprint(j), o.CellW))
		}
		w.WriteString("\n")
	}

	for i := r0; i < r1; i++ {
		wallLine(i)
		bodyLine(i)
	}
	wallLine(r1)

	fmt.Fprintf(w, "\nrows %d-%d, columns %d-%d\n", r0, r1-1, c0, c1-1)
}

// center pads s to width w, keeping the low-order digits when it does not fit —
// those identify a column better than the high-order ones.
func center(s string, w int) string {
	if len(s) >= w {
		return s[len(s)-w:]
	}
	left := (w - len(s)) / 2
	return strings.Repeat(" ", left) + s + strings.Repeat(" ", w-len(s)-left)
}
