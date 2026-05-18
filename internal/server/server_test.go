package server_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"onboard/internal/server"
)

func TestRoutesServeExpectedContent(t *testing.T) {
	t.Parallel()

	handler := server.New(server.Config{Mode: "local"})

	tests := []struct {
		name     string
		path     string
		contains string
	}{
		{name: "index", path: "/", contains: `href="/board"`},
		{name: "board", path: "/board", contains: `id="board-app"`},
		{name: "viewer", path: "/viewer", contains: `id="viewer-app"`},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}

			body := rec.Body.String()
			if !strings.Contains(body, tt.contains) {
				t.Fatalf("body does not contain %q:\n%s", tt.contains, body)
			}
		})
	}
}

func TestHealthReturnsOK(t *testing.T) {
	t.Parallel()

	handler := server.New(server.Config{Mode: "local"})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	body, err := io.ReadAll(rec.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}
	if string(body) != "ok" {
		t.Fatalf("body = %q, want %q", string(body), "ok")
	}
}

func TestServesEmbeddedJavaScriptModules(t *testing.T) {
	t.Parallel()

	handler := server.New(server.Config{Mode: "local"})
	req := httptest.NewRequest(http.MethodGet, "/core/protocol.js", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "export function createBoardEvent") {
		t.Fatalf("body does not contain JavaScript module content:\n%s", body)
	}
}
