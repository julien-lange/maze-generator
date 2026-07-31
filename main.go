//go:build !(js && wasm)

// Command maze generates mazes, either printed for A4 paper or packed as JSON
// for the browser player in docs/.
//
// The maze itself is a graph (maze.go); turning it into characters (print.go)
// or into JSON (pack.go) is a separate pass that only ever asks the graph which
// walls are open.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"time"
)

func main() {
	rows := flag.Int("n", 20, "number of rows (N)")
	cols := flag.Int("m", 15, "number of columns (M)")
	wallProb := flag.Float64("wall", 0.45, "probability that an interior wall is present")
	seed := flag.Uint64("seed", 0, "random seed (0 picks one from the clock)")
	out := flag.String("o", "", "write to this file instead of stdout")
	cellW := flag.Int("cw", 3, "interior width of a cell, in characters")
	unicode := flag.Bool("unicode", false, "draw with box-drawing characters instead of +-|")
	labels := flag.Bool("labels", true, "print row and column indices")
	packN := flag.Int("pack", 0, "write this many mazes as a JSON pack instead of printing one")
	tries := flag.Int("tries", 12, "candidates to generate per maze, keeping the twistiest")
	flag.Parse()

	if *rows < 1 || *cols < 1 {
		fatal("n and m must both be at least 1")
	}
	if *cellW < 1 {
		fatal("cw must be at least 1")
	}
	if *wallProb < 0 || *wallProb > 1 {
		fatal("wall must be between 0 and 1")
	}

	if *seed == 0 {
		*seed = uint64(time.Now().UnixNano())
		fmt.Fprintf(os.Stderr, "maze: seed %d\n", *seed) // so a good one can be replayed
	}
	rng := rand.New(rand.NewPCG(*seed, 0x9E3779B97F4A7C15))

	if *packN > 0 {
		writePack(BuildPack(*packN, *rows, *cols, *tries, rng), *out)
		return
	}

	// m := Random(*rows, *cols, *wallProb, rng)
	// m := DFS(*rows, *cols, rng)
	m := Prims(*rows, *cols, rng)

	w := os.Stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		w = f
	}
	bw := bufio.NewWriter(w)
	defer bw.Flush()

	startMark, endMark := AnimalPair(rng)
	Print(bw, m, layout{
		CellW:     *cellW,
		Labels:    *labels,
		Style:     styleFor(*unicode),
		Start:     Cell{0, 0},
		End:       Cell{m.Rows - 1, m.Cols - 1},
		StartMark: startMark,
		EndMark:   endMark,
	})
}

// writePack saves a pack where the player expects it, unless -o said otherwise.
func writePack(p packFile, dest string) {
	if dest == "" {
		dest = "docs/pack.json"
	}
	b, err := MarshalPack(p)
	if err != nil {
		fatal(err)
	}
	if err := os.WriteFile(dest, b, 0o644); err != nil {
		fatal(err)
	}
	fmt.Fprintf(os.Stderr, "maze: wrote %d mazes to %s (%d bytes)\n", len(p.Mazes), dest, len(b))
}

func fatal(v any) {
	fmt.Fprintln(os.Stderr, "maze:", v)
	os.Exit(1)
}
