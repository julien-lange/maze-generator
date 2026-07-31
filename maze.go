package main

import "math/rand/v2"

// Cell identifies a cell by its position in the grid.
type Cell struct{ Row, Col int }

// Maze is a grid graph. The vertices are the Rows x Cols cells; an edge joins
// two orthogonally adjacent cells when the wall between them is open, so a
// passage is an edge and a wall is a missing edge.
//
// Each wall is stored exactly once, on the cell to its north or west, which
// leaves no way for two cells to disagree about the wall they share. The outer
// boundary is not stored at all: it is always closed, and the arrays are sized
// so that only interior walls exist.
type Maze struct {
	Rows, Cols int
	east       [][]bool // east[i][j]: passage from (i,j) to (i,j+1); Rows x Cols-1
	south      [][]bool // south[i][j]: passage from (i,j) to (i+1,j); Rows-1 x Cols
}

// New returns a Rows x Cols maze with every wall closed: Cols*Rows vertices and
// no edges at all.
func New(rows, cols int) *Maze {
	m := &Maze{Rows: rows, Cols: cols, east: make([][]bool, rows), south: make([][]bool, rows-1)}
	for i := range m.east {
		m.east[i] = make([]bool, cols-1)
	}
	for i := range m.south {
		m.south[i] = make([]bool, cols)
	}
	return m
}

// Contains reports whether c is inside the grid.
func (m *Maze) Contains(c Cell) bool {
	return c.Row >= 0 && c.Row < m.Rows && c.Col >= 0 && c.Col < m.Cols
}

// OpenEast reports whether a passage leads east out of (row, col). Coordinates
// outside the grid, and the boundary walls, report false.
func (m *Maze) OpenEast(row, col int) bool {
	return row >= 0 && row < m.Rows && col >= 0 && col < m.Cols-1 && m.east[row][col]
}

// OpenSouth reports whether a passage leads south out of (row, col).
func (m *Maze) OpenSouth(row, col int) bool {
	return row >= 0 && row < m.Rows-1 && col >= 0 && col < m.Cols && m.south[row][col]
}

// edge returns a pointer to the flag for the wall a and b share, or nil if they
// are not two adjacent cells of this maze.
func (m *Maze) edge(a, b Cell) *bool {
	if !m.Contains(a) || !m.Contains(b) {
		return nil
	}
	if a.Row > b.Row || a.Col > b.Col {
		a, b = b, a // normalise: a is now the northern or western cell
	}
	switch {
	case a.Row == b.Row && b.Col-a.Col == 1:
		return &m.east[a.Row][a.Col]
	case a.Col == b.Col && b.Row-a.Row == 1:
		return &m.south[a.Row][a.Col]
	}
	return nil
}

// Linked reports whether an edge joins a and b, that is, whether one can step
// directly from a to b.
func (m *Maze) Linked(a, b Cell) bool {
	e := m.edge(a, b)
	return e != nil && *e
}

// Link opens the wall between a and b, adding that edge to the graph. It panics
// if the two cells are not adjacent, which is always a bug in the caller.
func (m *Maze) Link(a, b Cell) { m.setLink(a, b, true) }

// Unlink closes the wall between a and b, removing that edge.
func (m *Maze) Unlink(a, b Cell) { m.setLink(a, b, false) }

func (m *Maze) setLink(a, b Cell, open bool) {
	e := m.edge(a, b)
	if e == nil {
		panic("maze: cells are not adjacent")
	}
	*e = open
}

// Adjacent returns the cells sharing a wall with c, whether or not that wall is
// open. Generators walk these.
func (m *Maze) Adjacent(c Cell) []Cell {
	all := []Cell{
		{c.Row - 1, c.Col}, {c.Row, c.Col + 1},
		{c.Row + 1, c.Col}, {c.Row, c.Col - 1},
	}
	near := make([]Cell, 0, 4)
	for _, n := range all {
		if m.Contains(n) {
			near = append(near, n)
		}
	}
	return near
}

// Neighbours returns the cells reachable from c in one step: its neighbours in
// the graph, as opposed to in the grid. Solvers walk these.
func (m *Maze) Neighbours(c Cell) []Cell {
	near := make([]Cell, 0, 4)
	for _, n := range m.Adjacent(c) {
		if m.Linked(c, n) {
			near = append(near, n)
		}
	}
	return near
}

// Random returns a maze in which every interior wall is present with
// probability wallProb, each decided independently.
//
// This is deliberately the naive generator: the result is not a spanning tree,
// so expect sealed-off pockets and open rooms rather than a solvable maze.
func Random(rows, cols int, wallProb float64, rng *rand.Rand) *Maze {
	m := New(rows, cols)
	open := func(walls [][]bool) {
		for i := range walls {
			for j := range walls[i] {
				walls[i][j] = rng.Float64() >= wallProb
			}
		}
	}
	open(m.east)
	open(m.south)
	return m
}

// DFS carves a spanning tree with a randomised depth-first walk.
func DFS(rows, cols int, rng *rand.Rand) *Maze {
	m := New(rows, cols) // every wall closed; we only ever open

	visited := make([][]bool, rows)
	for i := range visited {
		visited[i] = make([]bool, cols)
	}

	var carve func(Cell)
	carve = func(c Cell) {
		visited[c.Row][c.Col] = true
		near := m.Adjacent(c)
		rng.Shuffle(len(near), func(i, j int) { near[i], near[j] = near[j], near[i] })
		for _, n := range near {
			if !visited[n.Row][n.Col] { // re-check: the recursion may have reached it
				m.Link(c, n)
				carve(n)
			}
		}
	}
	carve(Cell{rng.IntN(rows), rng.IntN(cols)})

	return m
}

type frontierEdge struct{ in, out Cell }

func Prims(rows, cols int, rng *rand.Rand) *Maze {
	m := New(rows, cols)

	visited := make([][]bool, rows)
	for i := range visited {
		visited[i] = make([]bool, cols)
	}

	var frontier []frontierEdge
	add := func(c Cell) { // absorb c, then offer its closed walls as candidates
		visited[c.Row][c.Col] = true
		for _, n := range m.Adjacent(c) {
			if !visited[n.Row][n.Col] {
				frontier = append(frontier, frontierEdge{c, n})
			}
		}
	}
	add(Cell{rng.IntN(rows), rng.IntN(cols)})

	for len(frontier) > 0 {
		k := rng.IntN(len(frontier))
		e := frontier[k]
		frontier[k] = frontier[len(frontier)-1] // swap-remove: O(1), order is irrelevant
		frontier = frontier[:len(frontier)-1]

		if visited[e.out.Row][e.out.Col] {
			continue // stale: something else reached out first
		}

		m.Link(e.in, e.out)
		add(e.out)
	}
	return m
}
