package main

import "embed"

// staticFS embeds all files under static/ at compile time.
// This makes the binary self-contained — no external static directory needed.
// The symlink cmd/server/static → ../../static lets embed reference it locally.
//
//go:embed static/index.html static/css/* static/js/*
var staticFS embed.FS