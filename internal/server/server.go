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

const relayWriteTimeout = 5 * time.Second

type Config struct {
	Mode           string
	Addr           string
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
	mux.HandleFunc("/ws/relay", relayEndpoint(relay))
	mux.HandleFunc("/signal", signalEndpoint(signalRegistry, signalPeers))

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

func relayEndpoint(relay *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()

		snapshot, events, unsubscribe := relay.SubscribeWithSnapshot()
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

func signalEndpoint(registry *signaling.Registry, peers *signalPeerIndex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
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
					fromPeerID, ok := peers.PairedPeerID(sessionID, peerID)
					if !ok {
						continue
					}
					message := signalMessage{
						Type:      "signal:" + string(signal.Type),
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

func writeRelayEvent(conn *websocket.Conn, event hub.Event) error {
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

	return hub.Event{
		ID:      id,
		Type:    eventType,
		BoardID: boardID,
		At:      at,
		Payload: payload,
	}, true
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
