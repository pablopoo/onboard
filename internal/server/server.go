package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"onboard/internal/hub"
	"onboard/internal/signaling"
	"onboard/web"
)

const (
	relayWriteTimeout    = 5 * time.Second
	relayReadLimitBytes  = 4 << 20
	signalReadLimitBytes = 1 << 20
	maxRelayStrokeWidth  = 128
	conflictCloseDelay   = 50 * time.Millisecond
)

var relaySurfaces = map[string]struct{}{
	"whiteboard": {},
	"blueboard":  {},
	"blackboard": {},
	"greenboard": {},
}

var relayMarkerSurfaces = map[string]struct{}{
	"whiteboard": {},
	"blueboard":  {},
}

var relayChalkSurfaces = map[string]struct{}{
	"blackboard": {},
	"greenboard": {},
}

type Config struct {
	Mode           string
	Addr           string
	BaseURLs       []string
	RelayHub       *hub.Hub
	SignalRegistry *signaling.Registry
}

func New(config Config) http.Handler {
	mux := http.NewServeMux()
	staticFiles := http.FileServer(http.FS(web.Assets))
	relay := config.RelayHub
	if relay == nil {
		relay = hub.New()
	}
	signalRegistry := config.SignalRegistry
	if signalRegistry == nil {
		signalRegistry = signaling.NewRegistry()
	}
	signalPeers := newSignalPeerIndex()

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
	mux.HandleFunc("/api/share", shareEndpoint(config.BaseURLs))
	mux.HandleFunc("/ws/relay", relayEndpoint(relay))
	mux.HandleFunc("/signal", signalEndpoint(signalRegistry, signalPeers))

	return mux
}

func shareEndpoint(configBaseURLs []string) http.HandlerFunc {
	baseURLs := normalizedBaseURLs(configBaseURLs)
	return func(w http.ResponseWriter, r *http.Request) {
		response := shareResponse{
			BaseURLs: append([]string(nil), baseURLs...),
			Paths: sharePaths{
				Home:   "/",
				Board:  "/board",
				Viewer: "/viewer",
			},
		}

		if origin := requestOrigin(r); origin != "" && !containsString(response.BaseURLs, origin) {
			response.BaseURLs = append(response.BaseURLs, origin)
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(response); err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
	}
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

func relayEndpoint(relay *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(relayReadLimitBytes)
		defer conn.CloseNow()

		role := relayRole(r)
		presenter := role == hub.RoleBoard
		if presenter {
			if !relay.AcquirePresenter() {
				_ = writeRelaySystemEvent(conn, relaySystemEvent{
					Type:    "system:presenter-conflict",
					Payload: map[string]any{"reason": "presenter-active"},
				})
				time.Sleep(conflictCloseDelay)
				_ = conn.Close(websocket.StatusPolicyViolation, "presenter active")
				return
			}
			defer relay.ReleasePresenter()
		}

		snapshot, events, unsubscribe := relay.SubscribeWithSnapshotRole(role)
		subscribed := true
		cleanup := func() {
			if subscribed {
				unsubscribe()
				subscribed = false
			}
		}
		defer cleanup()

		for _, event := range snapshot {
			if err := writeRelayEvent(conn, event); err != nil {
				return
			}
		}

		writerDone := make(chan struct{})
		go func() {
			defer close(writerDone)
			for event := range events {
				if err := writeRelayEvent(conn, event); err != nil {
					_ = conn.CloseNow()
					return
				}
			}
			_ = conn.CloseNow()
		}()

		readCtx := context.Background()
		for {
			messageType, data, err := conn.Read(readCtx)
			if err != nil {
				break
			}
			if messageType != websocket.MessageText {
				continue
			}
			if !presenter {
				continue
			}

			event, ok := parseRelayEvent(data)
			if !ok {
				continue
			}
			relay.Record(event)
		}

		cleanup()
		_ = conn.Close(websocket.StatusNormalClosure, "")
		<-writerDone
	}
}

func relayRole(r *http.Request) string {
	if r.URL.Query().Get("role") == hub.RoleBoard {
		return hub.RoleBoard
	}
	return hub.RoleViewer
}

func signalEndpoint(registry *signaling.Registry, peers *signalPeerIndex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(signalReadLimitBytes)
		defer conn.CloseNow()

		var writeMu sync.Mutex
		var unsubscribe func()
		var forwardDone <-chan struct{}
		var activeSessionID string
		var activePeerID string

		stopForwarding := func() {
			if unsubscribe != nil {
				unsubscribe()
				unsubscribe = nil
			}
			if forwardDone != nil {
				<-forwardDone
				forwardDone = nil
			}
		}
		releaseActivePeer := func() {
			if activeSessionID == "" || activePeerID == "" {
				return
			}
			if err := registry.ReleasePeer(activeSessionID, activePeerID); err == nil {
				peers.ReleasePeer(activeSessionID, activePeerID)
			}
			activeSessionID = ""
			activePeerID = ""
		}
		defer func() {
			stopForwarding()
			releaseActivePeer()
		}()

		startForwarding := func(sessionID string, peerID string) error {
			stopForwarding()
			releaseActivePeer()

			signals, unsubscribeNext, err := registry.Subscribe(sessionID, peerID)
			if err != nil {
				return err
			}

			done := make(chan struct{})
			unsubscribe = unsubscribeNext
			forwardDone = done
			activeSessionID = sessionID
			activePeerID = peerID
			go func() {
				defer close(done)
				for signal := range signals {
					fromPeerID := signal.FromPeerID
					if fromPeerID == "" {
						pairedPeerID, ok := peers.PairedPeerID(sessionID, peerID)
						if !ok {
							continue
						}
						fromPeerID = pairedPeerID
					}
					message := signalMessage{
						Type:      signalMessageType(signal.Type),
						SessionID: sessionID,
						PeerID:    fromPeerID,
						Payload:   signal.Payload,
					}
					if err := writeSignalMessage(conn, &writeMu, message); err != nil {
						_ = conn.CloseNow()
						return
					}
				}
			}()
			return nil
		}

		for {
			messageType, data, err := conn.Read(context.Background())
			if err != nil {
				break
			}
			if messageType != websocket.MessageText {
				continue
			}

			message, ok := parseSignalMessage(data)
			if !ok {
				if err := writeSignalError(conn, &writeMu, "malformed message"); err != nil {
					return
				}
				continue
			}

			switch message.Type {
			case "session:create":
				peerID, ok := requiredSignalString(message.PeerID)
				if !ok {
					if err := writeSignalError(conn, &writeMu, "missing required field"); err != nil {
						return
					}
					continue
				}

				session := registry.CreateSession(peerID)
				peers.Record(session)
				if err := startForwarding(session.ID, peerID); err != nil {
					if writeErr := writeSignalError(conn, &writeMu, signalErrorText(err)); writeErr != nil {
						return
					}
					continue
				}
				if err := writeSignalMessage(conn, &writeMu, signalMessage{
					Type:      "session:created",
					SessionID: session.ID,
					PeerID:    session.Board.ID,
					Role:      string(session.Board.Role),
				}); err != nil {
					return
				}

			case "session:join":
				sessionID, sessionOK := requiredSignalString(message.SessionID)
				peerID, peerOK := requiredSignalString(message.PeerID)
				if !sessionOK || !peerOK {
					if err := writeSignalError(conn, &writeMu, "missing required field"); err != nil {
						return
					}
					continue
				}

				session, err := registry.JoinSession(sessionID, peerID)
				if err != nil {
					if writeErr := writeSignalError(conn, &writeMu, signalErrorText(err)); writeErr != nil {
						return
					}
					continue
				}
				peers.Record(session)
				if err := startForwarding(session.ID, peerID); err != nil {
					if writeErr := writeSignalError(conn, &writeMu, signalErrorText(err)); writeErr != nil {
						return
					}
					continue
				}
				if err := writeSignalMessage(conn, &writeMu, signalMessage{
					Type:      "session:joined",
					SessionID: session.ID,
					PeerID:    session.Viewer.ID,
					Role:      string(session.Viewer.Role),
				}); err != nil {
					return
				}

			case "signal:offer", "signal:answer", "signal:ice":
				sessionID, sessionOK := requiredSignalString(message.SessionID)
				peerID, peerOK := requiredSignalString(message.PeerID)
				signalType, typeOK := signalTypeForMessage(message.Type)
				if !sessionOK || !peerOK || !typeOK || message.Payload == nil {
					if err := writeSignalError(conn, &writeMu, "missing required field"); err != nil {
						return
					}
					continue
				}

				err := registry.SendSignal(sessionID, peerID, signaling.Signal{
					Type:    signalType,
					Payload: message.Payload,
				})
				if err != nil {
					if writeErr := writeSignalError(conn, &writeMu, signalErrorText(err)); writeErr != nil {
						return
					}
					continue
				}

			default:
				if err := writeSignalError(conn, &writeMu, "unknown message type"); err != nil {
					return
				}
			}
		}

		stopForwarding()
		releaseActivePeer()
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}

func signalMessageType(signalType signaling.SignalType) string {
	if signalType == signaling.SignalPeerLeft {
		return "session:peer-left"
	}
	return "signal:" + string(signalType)
}

func writeRelayEvent(conn *websocket.Conn, event hub.Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

func writeRelaySystemEvent(conn *websocket.Conn, event relaySystemEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

func writeSignalMessage(conn *websocket.Conn, writeMu *sync.Mutex, message signalMessage) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}

	writeMu.Lock()
	defer writeMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

func writeSignalError(conn *websocket.Conn, writeMu *sync.Mutex, message string) error {
	return writeSignalMessage(conn, writeMu, signalMessage{
		Type:  "error",
		Error: message,
	})
}

func parseRelayEvent(data []byte) (hub.Event, bool) {
	fields, ok := decodeRelayFields(data)
	if !ok {
		return hub.Event{}, false
	}

	id, ok := decodeRequiredString(fields["id"])
	if !ok {
		return hub.Event{}, false
	}
	eventType, ok := decodeRequiredString(fields["type"])
	if !ok {
		return hub.Event{}, false
	}
	boardID, ok := decodeRequiredString(fields["boardId"])
	if !ok {
		return hub.Event{}, false
	}
	at, ok := decodeRequiredNumber(fields["at"])
	if !ok {
		return hub.Event{}, false
	}
	payload, ok := decodeRequiredPayload(fields["payload"])
	if !ok {
		return hub.Event{}, false
	}

	event := hub.Event{
		ID:      id,
		Type:    eventType,
		BoardID: boardID,
		At:      at,
		Payload: payload,
	}
	if !validateRelayEvent(event) {
		return hub.Event{}, false
	}
	return event, true
}

func validateRelayEvent(event hub.Event) bool {
	switch event.Type {
	case "board:set-surface":
		return validateRelaySurfacePayload(event.Payload)
	case "stroke:start":
		return validateRelayStrokeStartPayload(event.Payload)
	case "stroke:point":
		return validateRelayStrokePointPayload(event.Payload)
	case "stroke:end", "stroke:expire", "board:undo":
		return validateRelayStrokeIDPayload(event.Payload)
	case "board:restore":
		return validateRelayRestorePayload(event.Payload)
	case "pointer:show", "pointer:move":
		return validateRelayPointPayload(event.Payload)
	case "pointer:hide", "board:clear":
		return len(event.Payload) == 0
	default:
		return false
	}
}

func validateRelaySurfacePayload(payload map[string]any) bool {
	surface, ok := relayPayloadString(payload, "surface")
	return ok && isRelaySurface(surface)
}

func validateRelayStrokeStartPayload(payload map[string]any) bool {
	strokeIDOK := validateRelayStrokeIDPayload(payload)
	surface, surfaceOK := relayPayloadString(payload, "surface")
	tool, toolOK := relayPayloadString(payload, "tool")
	color, colorOK := relayPayloadString(payload, "color")
	width, widthOK := relayPayloadNumber(payload, "width")
	if !strokeIDOK ||
		!surfaceOK ||
		!isRelaySurface(surface) ||
		!toolOK ||
		!isRelayToolAllowedForSurface(tool, surface) ||
		!colorOK ||
		strings.TrimSpace(color) == "" ||
		!widthOK ||
		width <= 0 ||
		width > maxRelayStrokeWidth ||
		!validateRelayPointPayload(payload) {
		return false
	}

	ephemeral, hasEphemeral := payload["ephemeral"]
	if hasEphemeral {
		if _, ok := ephemeral.(bool); !ok {
			return false
		}
	}
	_, hasExpiresAt := payload["expiresAt"]
	if ephemeral == true {
		_, ok := relayPayloadNumber(payload, "expiresAt")
		return ok
	}
	if hasExpiresAt {
		return false
	}
	return true
}

func validateRelayStrokePointPayload(payload map[string]any) bool {
	return validateRelayStrokeIDPayload(payload) && validateRelayPointPayload(payload)
}

func validateRelayStrokeIDPayload(payload map[string]any) bool {
	_, ok := relayPayloadString(payload, "strokeId")
	return ok
}

func validateRelayRestorePayload(payload map[string]any) bool {
	if !validateRelaySurfacePayload(payload) {
		return false
	}

	strokes, ok := payload["strokes"].([]any)
	if !ok {
		return false
	}
	for _, value := range strokes {
		stroke, ok := value.(map[string]any)
		if !ok || !validateRelayRestoredStroke(stroke) {
			return false
		}
	}

	pointer, ok := payload["pointer"].(map[string]any)
	return ok && validateRelayPointerSnapshot(pointer)
}

func validateRelayRestoredStroke(stroke map[string]any) bool {
	strokeIDOK := validateRelayStrokeIDPayload(stroke)
	surface, surfaceOK := relayPayloadString(stroke, "surface")
	tool, toolOK := relayPayloadString(stroke, "tool")
	color, colorOK := relayPayloadString(stroke, "color")
	width, widthOK := relayPayloadNumber(stroke, "width")
	points, pointsOK := stroke["points"].([]any)
	_, completeOK := stroke["complete"].(bool)
	if !strokeIDOK ||
		!surfaceOK ||
		!isRelaySurface(surface) ||
		!toolOK ||
		!isRelayToolAllowedForSurface(tool, surface) ||
		!colorOK ||
		strings.TrimSpace(color) == "" ||
		!widthOK ||
		width <= 0 ||
		width > maxRelayStrokeWidth ||
		!pointsOK ||
		len(points) == 0 ||
		!completeOK {
		return false
	}
	for _, value := range points {
		point, ok := value.(map[string]any)
		if !ok || !validateRelayPointPayload(map[string]any{"point": point}) {
			return false
		}
	}

	ephemeral, hasEphemeral := stroke["ephemeral"]
	if hasEphemeral {
		if _, ok := ephemeral.(bool); !ok {
			return false
		}
	}
	_, hasExpiresAt := stroke["expiresAt"]
	if ephemeral == true {
		_, ok := relayPayloadNumber(stroke, "expiresAt")
		return ok
	}
	if hasExpiresAt {
		return false
	}
	return true
}

func validateRelayPointerSnapshot(pointer map[string]any) bool {
	visible, ok := pointer["visible"].(bool)
	if !ok {
		return false
	}
	if !visible {
		return pointer["point"] == nil
	}
	return validateRelayPointPayload(pointer)
}

func validateRelayPointPayload(payload map[string]any) bool {
	point, ok := payload["point"].(map[string]any)
	if !ok {
		return false
	}

	x, xOK := relayPayloadNumber(point, "x")
	y, yOK := relayPayloadNumber(point, "y")
	if !xOK || !yOK || !isRelayUnitNumber(x) || !isRelayUnitNumber(y) {
		return false
	}

	if _, exists := point["pressure"]; exists {
		pressure, ok := relayPayloadNumber(point, "pressure")
		return ok && isRelayUnitNumber(pressure)
	}
	return true
}

func relayPayloadString(payload map[string]any, key string) (string, bool) {
	value, ok := payload[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", false
	}
	return value, true
}

func relayPayloadNumber(payload map[string]any, key string) (float64, bool) {
	value, ok := payload[key]
	if !ok {
		return 0, false
	}
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) {
		return 0, false
	}
	return number, true
}

func isRelaySurface(surface string) bool {
	_, ok := relaySurfaces[surface]
	return ok
}

func isRelayToolAllowedForSurface(tool string, surface string) bool {
	if tool == "eraser" {
		return isRelaySurface(surface)
	}
	if tool == "marker" {
		_, ok := relayMarkerSurfaces[surface]
		return ok
	}
	if tool == "chalk" {
		_, ok := relayChalkSurfaces[surface]
		return ok
	}
	return false
}

func isRelayUnitNumber(value float64) bool {
	return value >= 0 && value <= 1
}

func parseSignalMessage(data []byte) (signalMessage, bool) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()

	var message signalMessage
	if err := decoder.Decode(&message); err != nil {
		return signalMessage{}, false
	}
	if err := decoder.Decode(&struct{}{}); err != nil {
		if errors.Is(err, io.EOF) {
			return message, true
		}
		return signalMessage{}, false
	}
	return signalMessage{}, false
}

func decodeRelayFields(data []byte) (map[string]json.RawMessage, bool) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()

	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil {
		return nil, false
	}
	if len(fields) == 0 {
		return nil, false
	}
	if err := decoder.Decode(&struct{}{}); err != nil {
		if errors.Is(err, io.EOF) {
			return fields, true
		}
		return nil, false
	}
	return nil, false
}

func decodeRequiredString(raw json.RawMessage) (string, bool) {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	if strings.TrimSpace(value) == "" {
		return "", false
	}
	return value, true
}

func decodeRequiredNumber(raw json.RawMessage) (float64, bool) {
	var value json.Number
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	number, err := value.Float64()
	if err != nil {
		return 0, false
	}
	if math.IsInf(number, 0) || math.IsNaN(number) {
		return 0, false
	}
	return number, true
}

func decodeRequiredPayload(raw json.RawMessage) (map[string]any, bool) {
	var payload map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil {
		return nil, false
	}
	if payload == nil {
		return nil, false
	}
	return payload, true
}

func requiredSignalString(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	return value, true
}

func signalTypeForMessage(messageType string) (signaling.SignalType, bool) {
	switch messageType {
	case "signal:offer":
		return signaling.SignalOffer, true
	case "signal:answer":
		return signaling.SignalAnswer, true
	case "signal:ice":
		return signaling.SignalICE, true
	default:
		return "", false
	}
}

func signalErrorText(err error) string {
	switch {
	case errors.Is(err, signaling.ErrUnknownSession):
		return "unknown session"
	case errors.Is(err, signaling.ErrUnknownPeer):
		return "unknown peer"
	case errors.Is(err, signaling.ErrPeerAlreadyJoined):
		return "peer already joined"
	case errors.Is(err, signaling.ErrPeerNotJoined):
		return "peer not joined"
	case errors.Is(err, signaling.ErrUnknownSignalType):
		return "unknown signal type"
	default:
		return "signaling error"
	}
}

type signalMessage struct {
	Type      string         `json:"type"`
	SessionID string         `json:"sessionId,omitempty"`
	PeerID    string         `json:"peerId,omitempty"`
	Role      string         `json:"role,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	Error     string         `json:"error,omitempty"`
}

type relaySystemEvent struct {
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type shareResponse struct {
	BaseURLs []string   `json:"baseUrls"`
	Paths    sharePaths `json:"paths"`
}

type sharePaths struct {
	Home   string `json:"home"`
	Board  string `json:"board"`
	Viewer string `json:"viewer"`
}

func normalizedBaseURLs(baseURLs []string) []string {
	normalized := make([]string, 0, len(baseURLs))
	for _, baseURL := range baseURLs {
		baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
		if baseURL == "" || containsString(normalized, baseURL) {
			continue
		}
		normalized = append(normalized, baseURL)
	}
	return normalized
}

func requestOrigin(r *http.Request) string {
	host := strings.TrimSpace(r.Host)
	if host == "" {
		return ""
	}

	scheme := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		scheme = "http"
		if r.TLS != nil {
			scheme = "https"
		}
	}
	if comma := strings.Index(scheme, ","); comma >= 0 {
		scheme = strings.TrimSpace(scheme[:comma])
	}
	if scheme == "" {
		return ""
	}
	return scheme + "://" + host
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type signalPeerIndex struct {
	mu       sync.RWMutex
	sessions map[string]signalSessionPeers
}

type signalSessionPeers struct {
	BoardID  string
	ViewerID string
}

func newSignalPeerIndex() *signalPeerIndex {
	return &signalPeerIndex{
		sessions: make(map[string]signalSessionPeers),
	}
}

func (p *signalPeerIndex) Record(session signaling.Session) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.sessions[session.ID] = signalSessionPeers{
		BoardID:  session.Board.ID,
		ViewerID: session.Viewer.ID,
	}
}

func (p *signalPeerIndex) ReleasePeer(sessionID string, peerID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	session, ok := p.sessions[sessionID]
	if !ok {
		return
	}
	switch peerID {
	case session.BoardID:
		delete(p.sessions, sessionID)
	case session.ViewerID:
		session.ViewerID = ""
		p.sessions[sessionID] = session
	}
}

func (p *signalPeerIndex) PairedPeerID(sessionID string, peerID string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	session, ok := p.sessions[sessionID]
	if !ok {
		return "", false
	}
	switch peerID {
	case session.BoardID:
		return session.ViewerID, session.ViewerID != ""
	case session.ViewerID:
		return session.BoardID, session.BoardID != ""
	default:
		return "", false
	}
}
