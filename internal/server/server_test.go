package server_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"onboard/internal/hub"
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

func TestRelayAcceptsWebSocketConnection(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	conn := dialRelay(t, testServer)
	closeWebSocket(t, conn)
}

func TestRelaySendsSnapshotEventsOnConnect(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	event := serverTestEvent("evt-1", "stroke:start")
	relay.Record(event)

	testServer := httptest.NewServer(server.New(server.Config{
		Mode:     "local",
		RelayHub: relay,
	}))
	t.Cleanup(testServer.Close)

	conn := dialRelay(t, testServer)
	defer closeWebSocket(t, conn)

	got := readRelayEvent(t, conn)
	if !reflectEvent(got, event) {
		t.Fatalf("snapshot event = %#v, want %#v", got, event)
	}
}

func TestRelayBroadcastsValidClientEventToAnotherClient(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	sender := dialRelay(t, testServer)
	defer closeWebSocket(t, sender)
	receiver := dialRelay(t, testServer)
	defer closeWebSocket(t, receiver)

	event := serverTestEvent("evt-1", "stroke:point")
	writeRelayEvent(t, sender, event)

	got := readRelayEvent(t, receiver)
	if !reflectEvent(got, event) {
		t.Fatalf("broadcast event = %#v, want %#v", got, event)
	}
}

func TestRelayIgnoresMalformedClientMessages(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		message string
	}{
		{name: "invalid json", message: `{"id":`},
		{name: "missing required fields", message: `{"id":"evt-1","type":"stroke:start","payload":{}}`},
		{name: "valid event followed by trailing garbage", message: `{"id":"evt-1","type":"stroke:point","boardId":"board-1","at":100,"payload":{"strokeId":"stroke-1"}} trailing-garbage`},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
			t.Cleanup(testServer.Close)

			sender := dialRelay(t, testServer)
			defer closeWebSocket(t, sender)
			receiver := dialRelay(t, testServer)
			defer closeWebSocket(t, receiver)

			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := sender.Write(ctx, websocket.MessageText, []byte(tt.message)); err != nil {
				t.Fatalf("write malformed message: %v", err)
			}

			assertNoRelayMessage(t, receiver)
		})
	}
}

func dialRelay(t *testing.T, testServer *httptest.Server) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/ws/relay"
	conn, response, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("dial relay: %v, status %d", err, response.StatusCode)
		}
		t.Fatalf("dial relay: %v", err)
	}

	return conn
}

func writeRelayEvent(t *testing.T, conn *websocket.Conn, event hub.Event) {
	t.Helper()

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write relay event: %v", err)
	}
}

func readRelayEvent(t *testing.T, conn *websocket.Conn) hub.Event {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	messageType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read relay event: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v, want %v", messageType, websocket.MessageText)
	}

	var event hub.Event
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatalf("unmarshal relay event: %v", err)
	}
	return event
}

func assertNoRelayMessage(t *testing.T, conn *websocket.Conn) {
	t.Helper()

	type readResult struct {
		data []byte
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		_, data, err := conn.Read(context.Background())
		result <- readResult{data: data, err: err}
	}()

	select {
	case got := <-result:
		if got.err == nil {
			t.Fatalf("unexpected relay message: %s", got.data)
		}
	case <-time.After(150 * time.Millisecond):
	}
}

func closeWebSocket(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close websocket: %v", err)
	}
}

func serverTestEvent(id string, eventType string) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    eventType,
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": "stroke-1",
		},
	}
}

func reflectEvent(a hub.Event, b hub.Event) bool {
	return a.ID == b.ID &&
		a.Type == b.Type &&
		a.BoardID == b.BoardID &&
		a.At == b.At &&
		reflectPayload(a.Payload, b.Payload)
}

func reflectPayload(a map[string]any, b map[string]any) bool {
	aJSON, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bJSON, err := json.Marshal(b)
	if err != nil {
		return false
	}
	return string(aJSON) == string(bJSON)
}
