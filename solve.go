package main

import "slices"

// Solve returns the shortest path from start to end, beginning at start and
// ending at end, or nil if the two are not connected. The carving generators
// produce spanning trees, in which that path is also the only one.
func (m *Maze) Solve(start, end Cell) []Cell {
	if !m.Contains(start) || !m.Contains(end) {
		return nil
	}
	id := func(c Cell) int { return c.Row*m.Cols + c.Col }

	const unseen = -1
	prev := make([]int, m.Rows*m.Cols)
	for i := range prev {
		prev[i] = unseen
	}
	prev[id(start)] = id(start) // its own parent, which also marks it seen

	for queue := []Cell{start}; len(queue) > 0; {
		c := queue[0]
		queue = queue[1:]
		if c == end {
			break
		}
		for _, n := range m.Neighbours(c) {
			if prev[id(n)] == unseen {
				prev[id(n)] = id(c)
				queue = append(queue, n)
			}
		}
	}
	if prev[id(end)] == unseen {
		return nil
	}

	var path []Cell
	for c := end; ; {
		path = append(path, c)
		if c == start {
			break
		}
		p := prev[id(c)]
		c = Cell{p / m.Cols, p % m.Cols}
	}
	slices.Reverse(path) // walked backwards from the end
	return path
}

// DeadEnds counts the cells with only one way out. They are the wrong turns a
// solver can take, so they say something about how much a maze fights back that
// the length of the solution alone does not.
func (m *Maze) DeadEnds() int {
	n := 0
	for i := range m.Rows {
		for j := range m.Cols {
			if len(m.Neighbours(Cell{i, j})) == 1 {
				n++
			}
		}
	}
	return n
}
