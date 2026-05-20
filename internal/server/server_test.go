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

func TestShareReturnsConfiguredBaseURLsAndRequestOriginFallback(t *testing.T) {
	t.Parallel()

	handler := server.New(server.Config{
		Mode:     "local",
		BaseURLs: []string{"http://localhost:8080", "http://192.168.1.20:8080"},
	})
	req := httptest.NewRequest(http.MethodGet, "/api/share", nil)
	req.Host = "example.test"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if contentType := rec.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("content type = %q, want application/json", contentType)
	}

	var response struct {
		BaseURLs []string `json:"baseUrls"`
		Paths    struct {
			Home   string `json:"home"`
			Board  string `json:"board"`
			Viewer string `json:"viewer"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal share response: %v", err)
	}

	wantBaseURLs := []string{"http://localhost:8080", "http://192.168.1.20:8080", "https://example.test"}
	if strings.Join(response.BaseURLs, ",") != strings.Join(wantBaseURLs, ",") {
		t.Fatalf("base URLs = %#v, want %#v", response.BaseURLs, wantBaseURLs)
	}
	if response.Paths.Home != "/" || response.Paths.Board != "/board" || response.Paths.Viewer != "/viewer" {
		t.Fatalf("paths = %#v, want home / board /board viewer /viewer", response.Paths)
	}
}

func TestShareUsesRequestOriginWhenConfigHasNoBaseURLs(t *testing.T) {
	t.Parallel()

	handler := server.New(server.Config{Mode: "local"})
	req := httptest.NewRequest(http.MethodGet, "/api/share", nil)
	req.Host = "localhost:1234"
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var response struct {
		BaseURLs []string `json:"baseUrls"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal share response: %v", err)
	}
	if len(response.BaseURLs) != 1 || response.BaseURLs[0] != "http://localhost:1234" {
		t.Fatalf("base URLs = %#v, want request origin fallback", response.BaseURLs)
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
	if got.Type != "board:restore" {
		t.Fatalf("snapshot event type = %q, want board:restore", got.Type)
	}
	if got.ID != event.ID {
		t.Fatalf("snapshot event ID = %q, want %q", got.ID, event.ID)
	}
	strokes, ok := got.Payload["strokes"].([]any)
	if !ok || len(strokes) != 1 {
		t.Fatalf("snapshot strokes = %#v, want one stroke", got.Payload["strokes"])
	}
	stroke, ok := strokes[0].(map[string]any)
	if !ok || stroke["strokeId"] != "stroke-1" {
		t.Fatalf("snapshot stroke = %#v, want stroke-1", strokes[0])
	}
}

func TestRelayBroadcastsValidClientEventToAnotherClient(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	sender := dialRelayRole(t, testServer, "board")
	defer closeWebSocket(t, sender)
	receiver := dialRelay(t, testServer)
	defer closeWebSocket(t, receiver)

	start := serverTestEvent("evt-start", "stroke:start")
	writeRelayEvent(t, sender, start)
	_ = readRelayEvent(t, receiver)

	event := serverTestEvent("evt-point", "stroke:point")
	writeRelayEvent(t, sender, event)
	got := readRelayEvent(t, receiver)
	if !reflectEvent(got, event) {
		t.Fatalf("broadcast event = %#v, want %#v", got, event)
	}
}

func TestRelayRejectsSecondBoardPresenter(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialRelayRole(t, testServer, "board")
	defer closeWebSocket(t, board)

	conflict := dialRelayRole(t, testServer, "board")
	defer conflict.CloseNow()

	got := readRelayEvent(t, conflict)
	if got.Type != "system:presenter-conflict" {
		t.Fatalf("conflict event type = %q, want system:presenter-conflict", got.Type)
	}
	if got.Payload["reason"] != "presenter-active" {
		t.Fatalf("conflict reason = %v, want presenter-active", got.Payload["reason"])
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := conflict.Read(ctx); err == nil {
		t.Fatal("second board connection stayed open after presenter conflict")
	}
}

func TestRelayViewersRemainUnlimitedWhileBoardPresenterActive(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialRelayRole(t, testServer, "board")
	defer closeWebSocket(t, board)
	viewerA := dialRelayRole(t, testServer, "viewer")
	defer closeWebSocket(t, viewerA)
	viewerB := dialRelayRole(t, testServer, "viewer")
	defer closeWebSocket(t, viewerB)

	start := serverTestEvent("evt-start", "stroke:start")
	writeRelayEvent(t, board, start)
	_ = readRelayEvent(t, viewerA)
	_ = readRelayEvent(t, viewerB)

	event := serverTestEvent("evt-point", "stroke:point")
	writeRelayEvent(t, board, event)
	if got := readRelayEvent(t, viewerA); !reflectEvent(got, event) {
		t.Fatalf("viewer A event = %#v, want %#v", got, event)
	}
	if got := readRelayEvent(t, viewerB); !reflectEvent(got, event) {
		t.Fatalf("viewer B event = %#v, want %#v", got, event)
	}
}

func TestRelayReportsViewerPresenceToBoardPresenter(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialRelayRole(t, testServer, "board")
	defer closeWebSocket(t, board)

	got := readRelayEvent(t, board)
	assertRelayPresence(t, got, 0)

	viewer := dialRelayRole(t, testServer, "viewer")

	got = readRelayEvent(t, board)
	assertRelayPresence(t, got, 1)

	closeWebSocket(t, viewer)

	got = readRelayEvent(t, board)
	assertRelayPresence(t, got, 0)
}

func TestRelayIgnoresEventsFromViewerSockets(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	viewerSender := dialRelayRole(t, testServer, "viewer")
	defer closeWebSocket(t, viewerSender)
	viewerReceiver := dialRelayRole(t, testServer, "viewer")
	defer closeWebSocket(t, viewerReceiver)

	writeRelayEvent(t, viewerSender, serverTestEvent("evt-viewer", "stroke:point"))
	assertNoRelayMessage(t, viewerReceiver)
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

			sender := dialRelayRole(t, testServer, "board")
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

func TestRelayIgnoresSemanticallyInvalidBoardEvents(t *testing.T) {
	t.Parallel()

	relayHub := hub.New()
	testServer := httptest.NewServer(server.New(server.Config{
		Mode:     "local",
		RelayHub: relayHub,
	}))
	t.Cleanup(testServer.Close)

	sender := dialRelayRole(t, testServer, "board")
	defer closeWebSocket(t, sender)
	receiver := dialRelay(t, testServer)
	defer closeWebSocket(t, receiver)

	event := serverTestEvent("evt-invalid", "stroke:start")
	event.Payload["point"] = map[string]any{
		"x":        1.25,
		"y":        0.5,
		"pressure": 0.5,
	}
	writeRelayEvent(t, sender, event)

	assertNoRelayMessage(t, receiver)
	if snapshot := relayHub.Snapshot(); len(snapshot) != 0 {
		t.Fatalf("snapshot length = %d, want 0: %#v", len(snapshot), snapshot)
	}
}

func TestRelayAcceptsLargeValidRestoreSnapshots(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	sender := dialRelayRole(t, testServer, "board")
	defer closeWebSocket(t, sender)
	receiver := dialRelay(t, testServer)
	receiver.SetReadLimit(4 << 20)
	defer closeWebSocket(t, receiver)

	event := largeRestoreEvent(t, "evt-large-restore", 1200)
	writeRelayEvent(t, sender, event)

	got := readRelayEvent(t, receiver)
	if got.ID != event.ID || got.Type != "board:restore" {
		t.Fatalf("large restore event = %#v, want ID %q type board:restore", got, event.ID)
	}
	strokes, ok := got.Payload["strokes"].([]any)
	if !ok || len(strokes) != 1 {
		t.Fatalf("large restore strokes = %#v, want one stroke", got.Payload["strokes"])
	}
	stroke, ok := strokes[0].(map[string]any)
	if !ok {
		t.Fatalf("large restore stroke = %#v, want object", strokes[0])
	}
	points, ok := stroke["points"].([]any)
	if !ok || len(points) != 1200 {
		t.Fatalf("large restore points length = %d, want 1200", len(points))
	}
}

func TestSignalAcceptsWebSocketConnection(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	conn := dialSignal(t, testServer)
	closeWebSocket(t, conn)
}

func TestSignalReportsMalformedMessagesAndKeepsSocketUsable(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	conn := dialSignal(t, testServer)
	defer closeWebSocket(t, conn)

	writeSignalMessage(t, conn, []byte(`{"type":`))
	assertSignalMessage(t, readSignalMessage(t, conn), signalTestMessage{
		Type:  "error",
		Error: "malformed message",
	})

	writeSignalJSON(t, conn, signalTestMessage{
		Type:   "session:create",
		PeerID: "board-1",
	})
	created := readSignalMessage(t, conn)
	if created.Type != "session:created" {
		t.Fatalf("message type = %q, want session:created: %#v", created.Type, created)
	}
	if created.SessionID == "" {
		t.Fatalf("created session ID is empty: %#v", created)
	}
	if created.PeerID != "board-1" {
		t.Fatalf("created peer ID = %q, want board-1", created.PeerID)
	}
	if created.Role != "board" {
		t.Fatalf("created role = %q, want board", created.Role)
	}
}

func TestSignalCreateJoinAndSignalMessagesUseRegistry(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialSignal(t, testServer)
	defer closeWebSocket(t, board)
	viewer := dialSignal(t, testServer)
	defer closeWebSocket(t, viewer)

	writeSignalJSON(t, board, signalTestMessage{
		Type:   "session:create",
		PeerID: "board-1",
	})
	created := readSignalMessage(t, board)
	if created.Type != "session:created" {
		t.Fatalf("created type = %q, want session:created: %#v", created.Type, created)
	}
	if created.SessionID == "" {
		t.Fatalf("created session ID is empty: %#v", created)
	}
	assertSignalMessage(t, created, signalTestMessage{
		Type:      "session:created",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Role:      "board",
	})

	writeSignalJSON(t, viewer, signalTestMessage{
		Type:      "session:join",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
	})
	assertSignalMessage(t, readSignalMessage(t, viewer), signalTestMessage{
		Type:      "session:joined",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
		Role:      "viewer",
	})

	offerPayload := map[string]any{"sdp": "offer-sdp"}
	writeSignalJSON(t, board, signalTestMessage{
		Type:      "signal:offer",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Payload:   offerPayload,
	})
	assertSignalMessage(t, readSignalMessage(t, viewer), signalTestMessage{
		Type:      "signal:offer",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Payload:   offerPayload,
	})

	answerPayload := map[string]any{"sdp": "answer-sdp"}
	writeSignalJSON(t, viewer, signalTestMessage{
		Type:      "signal:answer",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
		Payload:   answerPayload,
	})
	assertSignalMessage(t, readSignalMessage(t, board), signalTestMessage{
		Type:      "signal:answer",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
		Payload:   answerPayload,
	})

	icePayload := map[string]any{"candidate": "candidate-1"}
	writeSignalJSON(t, board, signalTestMessage{
		Type:      "signal:ice",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Payload:   icePayload,
	})
	assertSignalMessage(t, readSignalMessage(t, viewer), signalTestMessage{
		Type:      "signal:ice",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Payload:   icePayload,
	})
}

func TestSignalForwardsLargeValidOfferMessages(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialSignal(t, testServer)
	defer closeWebSocket(t, board)
	viewer := dialSignal(t, testServer)
	viewer.SetReadLimit(1 << 20)
	defer closeWebSocket(t, viewer)

	writeSignalJSON(t, board, signalTestMessage{
		Type:   "session:create",
		PeerID: "board-1",
	})
	created := readSignalMessage(t, board)
	if created.Type != "session:created" {
		t.Fatalf("created type = %q, want session:created: %#v", created.Type, created)
	}
	if created.SessionID == "" {
		t.Fatalf("created session ID is empty: %#v", created)
	}

	writeSignalJSON(t, viewer, signalTestMessage{
		Type:      "session:join",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
	})
	joined := readSignalMessage(t, viewer)
	if joined.Type != "session:joined" {
		t.Fatalf("joined type = %q, want session:joined: %#v", joined.Type, joined)
	}

	offerPayload := map[string]any{
		"type": "offer",
		"sdp":  strings.Repeat("a", 48*1024),
	}
	writeSignalJSON(t, board, signalTestMessage{
		Type:      "signal:offer",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Payload:   offerPayload,
	})

	assertSignalMessage(t, readSignalMessage(t, viewer), signalTestMessage{
		Type:      "signal:offer",
		SessionID: created.SessionID,
		PeerID:    "board-1",
		Payload:   offerPayload,
	})
}

func TestSignalViewerDisconnectAllowsReplacementViewer(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialSignal(t, testServer)
	defer closeWebSocket(t, board)
	viewer := dialSignal(t, testServer)

	writeSignalJSON(t, board, signalTestMessage{
		Type:   "session:create",
		PeerID: "board-1",
	})
	created := readSignalMessage(t, board)
	if created.Type != "session:created" {
		t.Fatalf("created type = %q, want session:created: %#v", created.Type, created)
	}

	writeSignalJSON(t, viewer, signalTestMessage{
		Type:      "session:join",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
	})
	assertSignalMessage(t, readSignalMessage(t, viewer), signalTestMessage{
		Type:      "session:joined",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
		Role:      "viewer",
	})
	closeWebSocket(t, viewer)
	assertSignalMessage(t, readSignalMessage(t, board), signalTestMessage{
		Type:      "session:peer-left",
		SessionID: created.SessionID,
		PeerID:    "viewer-1",
		Payload:   map[string]any{"role": "viewer"},
	})

	replacement := dialSignal(t, testServer)
	defer closeWebSocket(t, replacement)
	deadline := time.Now().Add(time.Second)
	for {
		writeSignalJSON(t, replacement, signalTestMessage{
			Type:      "session:join",
			SessionID: created.SessionID,
			PeerID:    "viewer-2",
		})
		message := readSignalMessage(t, replacement)
		if message.Type == "session:joined" {
			assertSignalMessage(t, message, signalTestMessage{
				Type:      "session:joined",
				SessionID: created.SessionID,
				PeerID:    "viewer-2",
				Role:      "viewer",
			})
			return
		}
		if message.Type != "error" || message.Error != "peer already joined" || time.Now().After(deadline) {
			t.Fatalf("replacement join message = %#v, want eventual session:joined", message)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSignalBoardDisconnectDeletesSessionForJoin(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	board := dialSignal(t, testServer)
	writeSignalJSON(t, board, signalTestMessage{
		Type:   "session:create",
		PeerID: "board-1",
	})
	created := readSignalMessage(t, board)
	if created.Type != "session:created" {
		t.Fatalf("created type = %q, want session:created: %#v", created.Type, created)
	}
	closeWebSocket(t, board)

	viewer := dialSignal(t, testServer)
	defer closeWebSocket(t, viewer)
	deadline := time.Now().Add(time.Second)
	for {
		writeSignalJSON(t, viewer, signalTestMessage{
			Type:      "session:join",
			SessionID: created.SessionID,
			PeerID:    "viewer-1",
		})
		message := readSignalMessage(t, viewer)
		if message.Type == "error" && message.Error == "unknown session" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("join after board disconnect = %#v, want unknown session", message)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSignalReportsUnknownSessionAndKeepsSocketUsable(t *testing.T) {
	t.Parallel()

	testServer := httptest.NewServer(server.New(server.Config{Mode: "local"}))
	t.Cleanup(testServer.Close)

	conn := dialSignal(t, testServer)
	defer closeWebSocket(t, conn)

	writeSignalJSON(t, conn, signalTestMessage{
		Type:      "session:join",
		SessionID: "missing-session",
		PeerID:    "viewer-1",
	})
	assertSignalMessage(t, readSignalMessage(t, conn), signalTestMessage{
		Type:  "error",
		Error: "unknown session",
	})

	writeSignalJSON(t, conn, signalTestMessage{
		Type:   "session:create",
		PeerID: "board-1",
	})
	created := readSignalMessage(t, conn)
	if created.Type != "session:created" {
		t.Fatalf("message type = %q, want session:created: %#v", created.Type, created)
	}
}

func dialRelay(t *testing.T, testServer *httptest.Server) *websocket.Conn {
	t.Helper()

	return dialRelayPath(t, testServer, "/ws/relay")
}

func dialRelayRole(t *testing.T, testServer *httptest.Server, role string) *websocket.Conn {
	t.Helper()

	return dialRelayPath(t, testServer, "/ws/relay?role="+role)
}

func dialRelayPath(t *testing.T, testServer *httptest.Server, path string) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(testServer.URL, "http") + path
	conn, response, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("dial relay: %v, status %d", err, response.StatusCode)
		}
		t.Fatalf("dial relay: %v", err)
	}

	return conn
}

func dialSignal(t *testing.T, testServer *httptest.Server) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/signal"
	conn, response, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("dial signal: %v, status %d", err, response.StatusCode)
		}
		t.Fatalf("dial signal: %v", err)
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

func writeSignalJSON(t *testing.T, conn *websocket.Conn, message signalTestMessage) {
	t.Helper()

	data, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal signal message: %v", err)
	}
	writeSignalMessage(t, conn, data)
}

func writeSignalMessage(t *testing.T, conn *websocket.Conn, data []byte) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write signal message: %v", err)
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

func readSignalMessage(t *testing.T, conn *websocket.Conn) signalTestMessage {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	messageType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read signal message: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v, want %v", messageType, websocket.MessageText)
	}

	var message signalTestMessage
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("unmarshal signal message %q: %v", data, err)
	}
	return message
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

func assertRelayPresence(t *testing.T, got hub.Event, viewerCount float64) {
	t.Helper()

	if got.Type != "system:relay-presence" {
		t.Fatalf("presence event type = %q, want system:relay-presence: %#v", got.Type, got)
	}
	if got.Payload["viewerCount"] != viewerCount {
		t.Fatalf("viewer count = %#v, want %#v", got.Payload["viewerCount"], viewerCount)
	}
}

func assertSignalMessage(t *testing.T, got signalTestMessage, want signalTestMessage) {
	t.Helper()

	if got.Type != want.Type ||
		got.SessionID != want.SessionID ||
		got.PeerID != want.PeerID ||
		got.Role != want.Role ||
		got.Error != want.Error ||
		!reflectPayload(got.Payload, want.Payload) {
		t.Fatalf("signal message = %#v, want %#v", got, want)
	}
}

type signalTestMessage struct {
	Type      string         `json:"type"`
	SessionID string         `json:"sessionId,omitempty"`
	PeerID    string         `json:"peerId,omitempty"`
	Role      string         `json:"role,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	Error     string         `json:"error,omitempty"`
}

func closeWebSocket(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close websocket: %v", err)
	}
}

func serverTestEvent(id string, eventType string) hub.Event {
	event := hub.Event{
		ID:      id,
		Type:    eventType,
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": "stroke-1",
		},
	}
	if eventType == "stroke:point" {
		event.Payload = map[string]any{
			"strokeId": "stroke-1",
			"point":    map[string]any{"x": 0.25, "y": 0.5, "pressure": 0},
		}
	}
	if eventType == "stroke:start" {
		event.Payload = map[string]any{
			"strokeId": "stroke-1",
			"surface":  "whiteboard",
			"tool":     "marker",
			"color":    "#111111",
			"width":    float64(4),
			"point":    map[string]any{"x": 0.25, "y": 0.5, "pressure": 0},
		}
	}
	return event
}

func largeRestoreEvent(t *testing.T, id string, pointCount int) hub.Event {
	t.Helper()

	points := make([]any, pointCount)
	for index := range points {
		points[index] = map[string]any{
			"x":        float64(index%100) / 100,
			"y":        float64((index*7)%100) / 100,
			"pressure": 0.5,
		}
	}

	event := hub.Event{
		ID:      id,
		Type:    "board:restore",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"surface": "whiteboard",
			"strokes": []any{
				map[string]any{
					"strokeId": "stroke-large",
					"surface":  "whiteboard",
					"tool":     "marker",
					"color":    "#111111",
					"width":    float64(4),
					"points":   points,
					"complete": true,
				},
			},
			"pointer": map[string]any{
				"visible": false,
				"point":   nil,
			},
		},
	}

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal large restore event: %v", err)
	}
	if len(data) <= 32768 {
		t.Fatalf("large restore event is %d bytes, want above default 32768-byte read limit", len(data))
	}
	return event
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
