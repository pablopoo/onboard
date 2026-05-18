package web

import "embed"

// Assets contains the static browser files served by the Go binary.
//
//go:embed *
var Assets embed.FS
