package server

import (
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"

	"onboard/web"
)

type Config struct {
	Mode string
	Addr string
}

func New(config Config) http.Handler {
	mux := http.NewServeMux()
	staticFiles := http.FileServer(http.FS(web.Assets))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			serveAsset(w, r, "index.html")
			return
		}
		staticFiles.ServeHTTP(w, r)
	})
	mux.HandleFunc("/board", func(w http.ResponseWriter, r *http.Request) {
		serveAsset(w, r, "board.html")
	})
	mux.HandleFunc("/viewer", func(w http.ResponseWriter, r *http.Request) {
		serveAsset(w, r, "viewer.html")
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})

	return mux
}

func serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	content, err := fs.ReadFile(web.Assets, name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	if filepath.Ext(name) == ".html" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	_, _ = w.Write(content)
}
