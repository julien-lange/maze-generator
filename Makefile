# Everything the browser needs lives in docs/, which is what GitHub Pages
# serves. `make` rebuilds both halves of it.

PACK ?= 40
ROWS ?= 20
COLS ?= 14
HOLD ?= 5
SEED ?= 20260731
PORT ?= 8731

.PHONY: all pack wasm pdf emoji-assets serve check clean

all: pack wasm

# The curated ladder: 40 mazes growing from small to full size in steps of
# HOLD mazes, each the twistiest of a dozen candidates.
pack:
	go run . -pack $(PACK) -n $(ROWS) -m $(COLS) -hold $(HOLD) -seed $(SEED) -o docs/pack.json

# The same generator again, this time for endless mazes in the page itself.
wasm:
	GOOS=js GOARCH=wasm go build -o docs/maze.wasm .
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" docs/wasm_exec.js

# The same pack on paper, one maze to an A4 sheet. Same SEED as `make pack`, so
# these are the same forty mazes he plays on the phone.
pdf:
	go run . -pack $(PACK) -n $(ROWS) -m $(COLS) -hold $(HOLD) -seed $(SEED) -pdf mazes.pdf

# Rebuild assets/emoji, the animal images the PDF embeds. Only needed if the
# animals list changes: the browser renders the glyph sheet, since it is the
# thing here that knows how to draw a colour emoji, and the tiles are named
# after their code points so the order cannot matter.
CHROME ?= /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
emoji-assets:
	@mkdir -p assets/emoji .check
	go run . -emoji-sheet .check/emoji.html > .check/emoji.list
	"$(CHROME)" --headless=new --disable-gpu --hide-scrollbars \
		--default-background-color=00000000 --virtual-time-budget=3000 \
		--window-size=1024,640 --screenshot=.check/emoji.png .check/emoji.html
	magick .check/emoji.png -crop 128x128 +repage .check/tile-%02d.png
	@i=0; while read -r name; do \
		mv ".check/tile-$$(printf %02d $$i).png" "assets/emoji/$$name"; \
		i=$$((i+1)); \
	done < .check/emoji.list
	@echo "rebuilt $$(ls assets/emoji | wc -l | tr -d ' ') glyphs"

serve:
	@echo "http://localhost:$(PORT)/"
	cd docs && python3 -m http.server $(PORT)

# The suites read what is in docs/, so rebuild the wasm first — otherwise a
# changed generator would be checked against yesterday's binary. The pack is
# deliberately left alone: it is built with flags you may have chosen, and
# `make check` should not quietly overwrite it with the defaults.
check: wasm
	go vet ./...
	go build -o /dev/null .
	HOLD=$(HOLD) node test/pack.js
	node test/player.js
	node test/wasm.js
	@mkdir -p .check
	go run . -pack $(PACK) -n $(ROWS) -m $(COLS) -hold $(HOLD) -seed $(SEED) -pdf .check/mazes.pdf
	node test/pdf.js .check/mazes.pdf

clean:
	rm -f docs/maze.wasm docs/wasm_exec.js docs/pack.json mazes.pdf
	rm -rf .check
