package web

import (
	"io/fs"
	"strings"
	"testing"
)

func TestEmbeddedAssetsContainOnlyProductionFiles(t *testing.T) {
	t.Parallel()

	required := map[string]bool{
		"index.html":          false,
		"board.html":          false,
		"viewer.html":         false,
		"styles.css":          false,
		"board/board.js":      false,
		"viewer/viewer.js":    false,
		"core/board-state.js": false,
		"transports/websocket-relay-transport.js": false,
		"icons/onboard.svg":                       false,
	}

	err := fs.WalkDir(Assets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasSuffix(path, ".go") || strings.HasSuffix(path, ".test.mjs") {
			t.Errorf("embedded non-production source %q", path)
		}
		if _, ok := required[path]; ok && !entry.IsDir() {
			required[path] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk embedded assets: %v", err)
	}

	for path, found := range required {
		if !found {
			t.Errorf("required production asset %q is not embedded", path)
		}
	}
}
