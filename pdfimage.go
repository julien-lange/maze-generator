//go:build !(js && wasm)

package main

import (
	"bytes"
	"compress/zlib"
	"embed"
	"fmt"
	"image"
	"image/draw"
	_ "image/png"
)

// The animals, pre-rendered by emoji.go's sheet and embedded here so that
// printing needs nothing but the binary. PDF has no way to draw a colour emoji
// as text, so each one goes in as an image: the colour in one stream and the
// transparency in a soft mask beside it.

//go:embed assets/emoji/*.png
var emojiAssets embed.FS

// emojiPool adds each glyph to the document once, however many sheets use it,
// and hands back the object number to draw with.
type emojiPool struct {
	doc  *pdfDoc
	nums map[string]int
}

func newEmojiPool(d *pdfDoc) *emojiPool {
	return &emojiPool{doc: d, nums: map[string]int{}}
}

// ref returns the image object for a glyph, embedding it on first use. ok is
// false when there is no asset for it, and the caller falls back to a shape —
// so a missing or unrebuilt assets/emoji still prints a usable maze.
func (p *emojiPool) ref(glyph string) (num int, ok bool) {
	if n, seen := p.nums[glyph]; seen {
		return n, n != 0
	}

	n, err := p.embed(glyph)
	if err != nil {
		p.nums[glyph] = 0 // remember the failure; do not retry it 40 times
		return 0, false
	}
	p.nums[glyph] = n
	return n, true
}

func (p *emojiPool) embed(glyph string) (int, error) {
	data, err := emojiAssets.ReadFile("assets/emoji/" + emojiFile(glyph))
	if err != nil {
		return 0, err
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return 0, err
	}

	// NRGBA, not RGBA: Go's RGBA is alpha-premultiplied, while PDF wants the
	// colour straight and the alpha kept separately in the mask.
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), src, b.Min, draw.Src)

	rgb := make([]byte, 0, w*h*3)
	alpha := make([]byte, 0, w*h)
	for i := 0; i < len(img.Pix); i += 4 {
		rgb = append(rgb, img.Pix[i], img.Pix[i+1], img.Pix[i+2])
		alpha = append(alpha, img.Pix[i+3])
	}

	mask := p.doc.addBinaryStream(fmt.Sprintf(
		"/Type /XObject /Subtype /Image /Width %d /Height %d "+
			"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", w, h),
		deflate(alpha))

	return p.doc.addBinaryStream(fmt.Sprintf(
		"/Type /XObject /Subtype /Image /Width %d /Height %d "+
			"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask %d 0 R",
		w, h, mask),
		deflate(rgb)), nil
}

func deflate(b []byte) []byte {
	var out bytes.Buffer
	z := zlib.NewWriter(&out)
	z.Write(b)
	z.Close()
	return out.Bytes()
}
