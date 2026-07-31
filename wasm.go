//go:build js && wasm

// This file is the whole of the WebAssembly build. It exports one function to
// the page and shares maze.go, solve.go and pack.go with the command-line tool,
// so there is only ever one generator to keep honest.
package main

import (
	"encoding/json"
	"math/rand/v2"
	"syscall/js"
	"time"
)

func main() {
	// Set before main blocks, so the export exists by the time go.run() hands
	// control back to the page.
	js.Global().Set("mazeGenerate", js.FuncOf(generate))
	select {} // syscall/js callbacks only run while main is alive
}

// generate implements window.mazeGenerate(rows, cols, [seed], [tries]) and
// returns one maze as a JSON string, in the same shape as an entry in
// pack.json. Handing back a string rather than a js.Value keeps the encoding in
// one place: the player parses a pack maze and a fresh maze identically.
func generate(_ js.Value, args []js.Value) any {
	rows, cols := 15, 10
	if len(args) > 0 {
		rows = args[0].Int()
	}
	if len(args) > 1 {
		cols = args[1].Int()
	}
	if rows < 1 || cols < 1 {
		return `{"error":"rows and cols must be at least 1"}`
	}

	seed := uint64(time.Now().UnixNano())
	if len(args) > 2 && args[2].Truthy() {
		seed = uint64(args[2].Float())
	}
	tries := 12
	if len(args) > 3 && args[3].Truthy() {
		tries = args[3].Int()
	}

	rng := rand.New(rand.NewPCG(seed, 0x9E3779B97F4A7C15))
	m := Pick(rows, cols, tries, rng)
	startMark, endMark := AnimalPair(rng)
	w := Encode(m, Cell{0, 0}, Cell{rows - 1, cols - 1}, startMark, endMark)

	b, err := json.Marshal(w)
	if err != nil {
		return `{"error":"encoding failed"}`
	}
	return string(b)
}
