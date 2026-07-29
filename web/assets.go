package web

import "embed"

// Assets contains the static browser files served by the Go binary.
//
//go:embed *.html *.webmanifest styles.css icons/*.png icons/*.svg board/*.js core/*.js home/*.js transports/*.js viewer/*.js
var Assets embed.FS
