package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"onboard/internal/hub"
	"onboard/web"
)

const (
	relayWriteTimeout                = 5 * time.Second
	relayReadLimitBytes              = 8 << 20
	maxRelayStrokeWidth              = 128
	maxRelayBackgroundDataURLLength  = 6_000_000
	maxRelayBackgroundImageDimension = 8192
	maxRelayEventIDBytes             = 128
	maxRelayBoardIDBytes             = 64
	maxRelayStrokeIDBytes            = 128
	maxRelayColorBytes               = 64
	maxRelayStrokes                  = 4_096
	maxRelayPointsPerStroke          = 8_192
	maxRelayTotalPoints              = 65_536
	maxRelayStateBytes               = 7_500_000
	maxRelayEphemeralLifetimeMillis  = 60_000
	conflictCloseDelay               = 50 * time.Millisecond
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
	Mode                string
	Addr                string
	BaseURLs            []string
	RelayHub            *hub.Hub
	PresenterCapability string
	RelayPingInterval   time.Duration
	RelayPingTimeout    time.Duration
}

func HTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

func New(config Config) http.Handler {
	mux := http.NewServeMux()
	staticFiles := http.FileServer(http.FS(web.Assets))
	relay := config.RelayHub
	if relay == nil {
		relay = hub.New()
	}
	connections := newConnectionGate()
	pingInterval := config.RelayPingInterval
	if pingInterval <= 0 {
		pingInterval = 15 * time.Second
	}
	pingTimeout := config.RelayPingTimeout
	if pingTimeout <= 0 {
		pingTimeout = 5 * time.Second
	}

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
	mux.HandleFunc("/ws/relay", relayEndpoint(
		relay,
		config.PresenterCapability,
		connections,
		pingInterval,
		pingTimeout,
	))

	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
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

func relayEndpoint(
	relay *hub.Hub,
	presenterCapability string,
	connections *connectionGate,
	pingInterval time.Duration,
	pingTimeout time.Duration,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		releaseConnection, ok := connections.acquire(r.RemoteAddr)
		if !ok {
			http.Error(w, "relay connection limit reached", http.StatusServiceUnavailable)
			return
		}
		defer releaseConnection()

		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(relayReadLimitBytes)
		defer conn.CloseNow()

		role := relayRole(r)
		presenter := role == hub.RoleBoard
		presenterOwner := r.RemoteAddr
		if presenter {
			if !presenterAuthorized(presenterCapability, r.URL.Query().Get("presenter")) {
				_ = writeRelaySystemEvent(conn, relaySystemEvent{
					Type:    "system:presenter-unauthorized",
					Payload: map[string]any{"reason": "presenter-capability"},
				})
				time.Sleep(conflictCloseDelay)
				_ = conn.Close(websocket.StatusPolicyViolation, "presenter capability required")
				return
			}
			if !relay.AcquirePresenter(presenterOwner) {
				_ = writeRelaySystemEvent(conn, relaySystemEvent{
					Type:    "system:presenter-conflict",
					Payload: map[string]any{"reason": "presenter-active"},
				})
				time.Sleep(conflictCloseDelay)
				_ = conn.Close(websocket.StatusPolicyViolation, "presenter active")
				return
			}
			defer relay.ReleasePresenter(presenterOwner)
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
		if err := writeRelaySystemEvent(conn, relaySystemEvent{
			Type:    "system:relay-ready",
			Payload: map[string]any{},
		}); err != nil {
			return
		}

		writerDone := make(chan struct{})
		go func() {
			defer close(writerDone)
			ticker := time.NewTicker(pingInterval)
			defer ticker.Stop()
			for {
				select {
				case event, ok := <-events:
					if !ok {
						_ = conn.CloseNow()
						return
					}
					if err := writeRelayEvent(conn, event); err != nil {
						_ = conn.CloseNow()
						return
					}
				case <-ticker.C:
					ctx, cancel := context.WithTimeout(context.Background(), pingTimeout)
					err := conn.Ping(ctx)
					cancel()
					if err == nil {
						continue
					}
					_ = conn.CloseNow()
					return
				}
			}
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

type connectionGate struct {
	mu       sync.Mutex
	total    int
	bySource map[string]int
}

func newConnectionGate() *connectionGate {
	return &connectionGate{bySource: make(map[string]int)}
}

func (g *connectionGate) acquire(remoteAddr string) (func(), bool) {
	source := remoteAddr
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		source = host
	}

	g.mu.Lock()
	if g.total >= 128 || g.bySource[source] >= 64 {
		g.mu.Unlock()
		return nil, false
	}
	g.total++
	g.bySource[source]++
	g.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			g.total--
			g.bySource[source]--
			if g.bySource[source] == 0 {
				delete(g.bySource, source)
			}
		})
	}, true
}

func presenterAuthorized(expected string, supplied string) bool {
	if expected == "" {
		return true
	}
	if len(expected) != len(supplied) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(supplied)) == 1
}

func relayRole(r *http.Request) string {
	if r.URL.Query().Get("role") == hub.RoleBoard {
		return hub.RoleBoard
	}
	return hub.RoleViewer
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

func parseRelayEvent(data []byte) (hub.Event, bool) {
	fields, ok := decodeRelayFields(data)
	if !ok {
		return hub.Event{}, false
	}

	id, ok := decodeRequiredString(fields["id"])
	if !ok || len(id) > maxRelayEventIDBytes {
		return hub.Event{}, false
	}
	eventType, ok := decodeRequiredString(fields["type"])
	if !ok {
		return hub.Event{}, false
	}
	boardID, ok := decodeRequiredString(fields["boardId"])
	if !ok || len(boardID) > maxRelayBoardIDBytes {
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
	case "board:set-background":
		return validateRelaySetBackgroundPayload(event.Payload)
	case "stroke:start":
		return validateRelayStrokeStartPayload(event.Payload, event.At)
	case "stroke:point":
		return validateRelayStrokePointPayload(event.Payload)
	case "stroke:end", "stroke:expire", "board:undo":
		return validateRelayStrokeIDPayload(event.Payload)
	case "board:restore":
		return validateRelayRestorePayload(event.Payload, event.At)
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

func validateRelaySetBackgroundPayload(payload map[string]any) bool {
	background, exists := payload["background"]
	if !exists {
		return false
	}
	return validateRelayBackgroundSnapshot(background)
}

func validateRelayBackgroundSnapshot(background any) bool {
	if background == nil {
		return true
	}

	payload, ok := background.(map[string]any)
	if !ok {
		return false
	}

	kind, kindOK := relayPayloadString(payload, "kind")
	dataURL, dataURLOK := relayPayloadString(payload, "dataUrl")
	width, widthOK := relayPayloadNumber(payload, "width")
	height, heightOK := relayPayloadNumber(payload, "height")

	return kindOK &&
		kind == "image" &&
		dataURLOK &&
		strings.HasPrefix(dataURL, "data:image/jpeg;base64,") &&
		len(dataURL) <= maxRelayBackgroundDataURLLength &&
		widthOK &&
		width > 0 &&
		width <= maxRelayBackgroundImageDimension &&
		heightOK &&
		height > 0 &&
		height <= maxRelayBackgroundImageDimension
}

func validateRelayStrokeStartPayload(payload map[string]any, eventAt float64) bool {
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
		len(color) > maxRelayColorBytes ||
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
		expiresAt, ok := relayPayloadNumber(payload, "expiresAt")
		return ok && expiresAt <= eventAt+maxRelayEphemeralLifetimeMillis
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
	strokeID, ok := relayPayloadString(payload, "strokeId")
	return ok && len(strokeID) <= maxRelayStrokeIDBytes
}

func validateRelayRestorePayload(payload map[string]any, eventAt float64) bool {
	if !validateRelaySurfacePayload(payload) {
		return false
	}
	serialized, err := json.Marshal(payload)
	if err != nil || len(serialized) > maxRelayStateBytes {
		return false
	}
	if background, exists := payload["background"]; exists {
		if !validateRelayBackgroundSnapshot(background) {
			return false
		}
	}

	strokes, ok := payload["strokes"].([]any)
	if !ok || len(strokes) > maxRelayStrokes {
		return false
	}
	strokeIDs := make(map[string]struct{}, len(strokes))
	totalPoints := 0
	for _, value := range strokes {
		stroke, ok := value.(map[string]any)
		if !ok || !validateRelayRestoredStroke(stroke, eventAt) {
			return false
		}
		strokeID, _ := relayPayloadString(stroke, "strokeId")
		if _, exists := strokeIDs[strokeID]; exists {
			return false
		}
		strokeIDs[strokeID] = struct{}{}
		points := stroke["points"].([]any)
		totalPoints += len(points)
		if totalPoints > maxRelayTotalPoints {
			return false
		}
	}

	pointer, ok := payload["pointer"].(map[string]any)
	return ok && validateRelayPointerSnapshot(pointer)
}

func validateRelayRestoredStroke(stroke map[string]any, eventAt float64) bool {
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
		len(color) > maxRelayColorBytes ||
		!widthOK ||
		width <= 0 ||
		width > maxRelayStrokeWidth ||
		!pointsOK ||
		len(points) == 0 ||
		len(points) > maxRelayPointsPerStroke ||
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
		expiresAt, ok := relayPayloadNumber(stroke, "expiresAt")
		return ok && expiresAt <= eventAt+maxRelayEphemeralLifetimeMillis
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
