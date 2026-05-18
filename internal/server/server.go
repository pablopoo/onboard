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
	"time"

	"github.com/coder/websocket"

	"onboard/internal/hub"
	"onboard/web"
)

const relayWriteTimeout = 5 * time.Second

type Config struct {
	Mode     string
	Addr     string
	RelayHub *hub.Hub
}

func New(config Config) http.Handler {
	mux := http.NewServeMux()
	staticFiles := http.FileServer(http.FS(web.Assets))
	relay := config.RelayHub
	if relay == nil {
		relay = hub.New()
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
	mux.HandleFunc("/ws/relay", relayEndpoint(relay))

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

func writeRelayEvent(conn *websocket.Conn, event hub.Event) error {
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
