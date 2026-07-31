# Everything the browser needs lives in docs/, which is what GitHub Pages
# serves. `make` rebuilds both halves of it.

PACK ?= 40
ROWS ?= 20
COLS ?= 14
SEED ?= 20260731
PORT ?= 8731

.PHONY: all pack wasm serve check clean

all: pack wasm

# The curated ladder: 40 mazes growing from small to full size, each the
# twistiest of a dozen candidates.
pack:
	go run . -pack $(PACK) -n $(ROWS) -m $(COLS) -seed $(SEED) -o docs/pack.json

# The same generator again, this time for endless mazes in the page itself.
wasm:
	GOOS=js GOARCH=wasm go build -o docs/maze.wasm .
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" docs/wasm_exec.js

serve:
	@echo "http://localhost:$(PORT)/"
	cd docs && python3 -m http.server $(PORT)

check:
	go vet ./...
	go build -o /dev/null .

clean:
	rm -f docs/maze.wasm docs/wasm_exec.js docs/pack.json
