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
