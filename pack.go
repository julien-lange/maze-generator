package main

import (
	"encoding/base64"
	"encoding/json"
	"math/rand/v2"
	"sort"
)

// The browser gets the same graph the printer gets, encoded as two bitsets in
// the order the Go slices already have them: east row by row, then south row by
// row. Nothing here knows how a maze is drawn — that is the player's business,
// exactly as it is print.go's.

// wire is one maze as the player reads it.
type wire struct {
	Rows      int      `json:"rows"`
	Cols      int      `json:"cols"`
	East      string   `json:"east"`  // base64 bitset, Rows*(Cols-1) bits
	South     string   `json:"south"` // base64 bitset, (Rows-1)*Cols bits
	Start     [2]int   `json:"start"`
	End       [2]int   `json:"end"`
	StartMark string   `json:"startMark"`
	EndMark   string   `json:"endMark"`
	Solution  [][2]int `json:"solution"`
	Stars     int      `json:"stars"` // 1-5, assigned relative to the rest of the pack
}

// packFile is what lands in docs/pack.json.
type packFile struct {
	Version int    `json:"version"`
	Mazes   []wire `json:"mazes"`
}

// packBits flattens a wall array to a bitset, least significant bit first
// within each byte, and base64s it. A 15x10 maze comes to 56 characters.
func packBits(walls [][]bool) string {
	n := 0
	for _, row := range walls {
		n += len(row)
	}
	buf := make([]byte, (n+7)/8)
	i := 0
	for _, row := range walls {
		for _, open := range row {
			if open {
				buf[i/8] |= 1 << (i % 8)
			}
			i++
		}
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// Encode packages a maze for the player. The solution travels with it so the
// player can offer a hint and can tell that a path has arrived without having
// to solve anything itself.
func Encode(m *Maze, start, end Cell, startMark, endMark string) wire {
	sol := m.Solve(start, end)
	steps := make([][2]int, len(sol))
	for i, c := range sol {
		steps[i] = [2]int{c.Row, c.Col}
	}
	return wire{
		Rows:      m.Rows,
		Cols:      m.Cols,
		East:      packBits(m.east),
		South:     packBits(m.south),
		Start:     [2]int{start.Row, start.Col},
		End:       [2]int{end.Row, end.Col},
		StartMark: startMark,
		EndMark:   endMark,
		Solution:  steps,
	}
}

// Pick generates tries candidates and keeps the one whose solution is longest.
//
// Prim's tends to run the answer fairly directly between the corners, which
// makes for a dull maze; taking the best of a handful costs nothing at this
// size and reliably buys a path that wanders. Best-of-N rather than
// reject-and-retry so that the loop cannot fail to terminate on a shape where
// the threshold is unreachable.
func Pick(rows, cols, tries int, rng *rand.Rand) *Maze {
	start, end := Cell{0, 0}, Cell{rows - 1, cols - 1}
	var best *Maze
	bestLen := -1
	for range max(tries, 1) {
		m := Prims(rows, cols, rng)
		if n := len(m.Solve(start, end)); n > bestLen {
			best, bestLen = m, n
		}
	}
	return best
}

// BuildPack generates count mazes that grow from small to full size, sorts them
// by how long their solutions are, and awards stars by where each one lands in
// that order — so the stars always climb, whatever the generator happened to
// produce.
func BuildPack(count, maxRows, maxCols, tries int, rng *rand.Rand) packFile {
	minRows, minCols := max(maxRows/3, 4), max(maxCols/3, 4)

	mazes := make([]wire, 0, count)
	for k := range count {
		t := 0.0
		if count > 1 {
			t = float64(k) / float64(count-1)
		}
		rows := minRows + int(t*float64(maxRows-minRows)+0.5)
		cols := minCols + int(t*float64(maxCols-minCols)+0.5)

		m := Pick(rows, cols, tries, rng)
		startMark, endMark := AnimalPair(rng)
		mazes = append(mazes, Encode(m, Cell{0, 0}, Cell{rows - 1, cols - 1}, startMark, endMark))
	}

	sort.SliceStable(mazes, func(i, j int) bool {
		return len(mazes[i].Solution) < len(mazes[j].Solution)
	})
	for i := range mazes {
		mazes[i].Stars = 1 + i*5/len(mazes) // quintile of the sorted pack
	}
	return packFile{Version: 1, Mazes: mazes}
}

// MarshalPack renders a pack as compact JSON: it is downloaded, not read, and
// the solutions indent into several times their own size.
func MarshalPack(p packFile) ([]byte, error) { return json.Marshal(p) }
