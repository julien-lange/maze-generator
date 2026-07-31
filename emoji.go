//go:build !(js && wasm)

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Colour emoji cannot be written into a PDF as text: the glyphs live in bitmap
// or layered-colour tables that PDF's font model has no notion of, and
// embedding such a font is a large job for a printout. So the animals travel as
// small images instead, pre-rendered once into assets/emoji and embedded in the
// binary (see pdfimage.go).
//
// This file builds the sheet those images are cut from. Rendering is the
// browser's job — it is the thing on this machine that knows how to draw a
// colour emoji — and doing it from the real animals slice is what stops the
// assets drifting out of step with the game.

const (
	emojiTile = 128 // pixels per glyph on the sheet
	emojiCols = 8
)

// emojiFile is the asset name for a glyph, taken from its code points so that
// reordering animals cannot invalidate the files.
func emojiFile(glyph string) string {
	parts := make([]string, 0, 2)
	for _, r := range glyph {
		parts = append(parts, fmt.Sprintf("%x", r))
	}
	return strings.Join(parts, "-") + ".png"
}

// writeEmojiSheet writes an HTML grid of every animal and prints the asset
// filename for each tile, in reading order, so the crop step can name them.
func writeEmojiSheet(dest string) {
	rows := (len(animals) + emojiCols - 1) / emojiCols

	var b strings.Builder
	b.WriteString("<!DOCTYPE html><meta charset=\"utf-8\">\n<style>\n")
	b.WriteString("html,body{margin:0;background:transparent}\n")
	fmt.Fprintf(&b, "#g{display:grid;grid-template-columns:repeat(%d,%dpx);"+
		"grid-auto-rows:%dpx;width:%dpx}\n", emojiCols, emojiTile, emojiTile, emojiCols*emojiTile)
	fmt.Fprintf(&b, "span{display:flex;align-items:center;justify-content:center;"+
		"font-size:%dpx;line-height:1;font-family:\"Apple Color Emoji\",\"Segoe UI Emoji\","+
		"\"Noto Color Emoji\",sans-serif}\n", emojiTile*82/100)
	b.WriteString("</style>\n<div id=\"g\">")
	for _, a := range animals {
		fmt.Fprintf(&b, "<span>%s</span>", a)
	}
	// Pad the last row so the crop always yields whole tiles.
	for i := len(animals); i < rows*emojiCols; i++ {
		b.WriteString("<span></span>")
	}
	b.WriteString("</div>\n")

	if err := os.WriteFile(dest, []byte(b.String()), 0o644); err != nil {
		fatal(err)
	}

	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for _, a := range animals {
		fmt.Fprintln(out, emojiFile(a))
	}
	fmt.Fprintf(os.Stderr, "maze: wrote %s, %d glyphs, %dx%d px sheet\n",
		dest, len(animals), emojiCols*emojiTile, rows*emojiTile)
}
