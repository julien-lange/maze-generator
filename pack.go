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

	// What the maze turned out to be, so the page can show it and you can see
	// which kinds he is getting through.
	Algo      string `json:"algo"`
	Steps     int    `json:"steps"`
	Junctions int    `json:"junctions"`
	Score     int    `json:"score"`
	Stars     int    `json:"stars"` // 1-5, assigned relative to the rest of the pack
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

// Score measures how hard a maze is to get through. Every step costs one and
// every junction costs three, because for a small child it is the wrong turns
// that defeat him, not the walking. It is what the pack is sorted and starred
// by, and it is comparable across the two generators, which a raw step count is
// not: DFS runs long and straight, Prim's runs short and forked.
func Score(steps, junctions int) int { return steps + 3*junctions }

// Encode packages a maze for the player, measured. The solution travels with it
// so the player can tell that a path has arrived without solving anything
// itself, and so the numbers below can be checked against it.
func Encode(m *Maze, start, end Cell, startMark, endMark, algo string) wire {
	sol := m.Solve(start, end)
	steps := make([][2]int, len(sol))
	for i, c := range sol {
		steps[i] = [2]int{c.Row, c.Col}
	}
	junctions := m.Junctions(sol)
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
		Algo:      algo,
		Steps:     len(sol),
		Junctions: junctions,
		Score:     Score(len(sol), junctions),
	}
}

// generators are the carving algorithms a pack draws on. They fail differently,
// which is the point of using both: Prim's grows from a frontier and so forks
// constantly, giving short direct solutions past a great many wrong turnings;
// DFS carves one long corridor and backtracks, giving a winding solution with
// far fewer decisions in it. A pack of only one kind gets samey fast.
var generators = []struct {
	Name  string
	Carve func(rows, cols int, rng *rand.Rand) *Maze
}{
	{"prim", Prims},
	{"dfs", DFS},
}

// Pick generates tries candidates with one generator and keeps the one that
// scores highest, which weeds out the occasional maze whose answer runs almost
// straight from corner to corner. Best-of-N rather than reject-and-retry, so
// the loop cannot fail to terminate on a shape where a threshold is
// unreachable. gen selects the generator, by index, wrapping.
func Pick(rows, cols, tries, gen int, rng *rand.Rand) (*Maze, string) {
	g := generators[((gen%len(generators))+len(generators))%len(generators)]
	start, end := Cell{0, 0}, Cell{rows - 1, cols - 1}

	var best *Maze
	bestScore := -1
	for range max(tries, 1) {
		m := g.Carve(rows, cols, rng)
		sol := m.Solve(start, end)
		if s := Score(len(sol), m.Junctions(sol)); s > bestScore {
			best, bestScore = m, s
		}
	}
	return best, g.Name
}

// BuildPack generates count mazes that grow from small to full size, alternating
// generators so both kinds turn up at every size, then sorts them by measured
// score and awards stars by where each one lands in that order — so the stars
// always climb, whatever the generators happened to produce.
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

		m, algo := Pick(rows, cols, tries, k, rng) // k alternates the generator
		startMark, endMark := AnimalPair(rng)
		mazes = append(mazes, Encode(m, Cell{0, 0}, Cell{rows - 1, cols - 1}, startMark, endMark, algo))
	}

	sort.SliceStable(mazes, func(i, j int) bool { return mazes[i].Score < mazes[j].Score })
	for i := range mazes {
		mazes[i].Stars = 1 + i*5/len(mazes) // quintile of the sorted pack
	}
	return packFile{Version: 1, Mazes: mazes}
}

// MarshalPack renders a pack as compact JSON: it is downloaded, not read, and
// the solutions indent into several times their own size.
func MarshalPack(p packFile) ([]byte, error) { return json.Marshal(p) }
