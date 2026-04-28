BINARY_NAME := piweb
CMD_DIR     := cmd/server
EMBED_DIR   := $(CMD_DIR)/static

.PHONY: all build run clean install uninstall

# Default target
all: build

# Copy static files for embedding, then build
build: copy-static
	go build -o $(BINARY_NAME) ./$(CMD_DIR)

# Prepare embedded static files (required before build — Go embed can't use .. paths)
copy-static:
	@go run copy_static.go

# Build and run
run: build
	./$(BINARY_NAME)

# Clean build artifacts
clean:
	rm -f $(BINARY_NAME)
	rm -rf $(EMBED_DIR)

# Install to $GOPATH/bin (or $GOBIN if set)
install: copy-static
	go install ./$(CMD_DIR)

# Uninstall from $GOPATH/bin
uninstall:
	go clean -i ./$(CMD_DIR)