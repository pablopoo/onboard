package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"onboard/internal/hub"
)

func TestParseRelayEventRejectsProtocolLimits(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{
			name: "oversized event ID",
			mutate: func(event map[string]any) {
				event["id"] = strings.Repeat("x", 129)
			},
		},
		{
			name: "oversized board ID",
			mutate: func(event map[string]any) {
				event["boardId"] = strings.Repeat("x", 65)
			},
		},
		{
			name: "oversized stroke ID",
			mutate: func(event map[string]any) {
				event["payload"].(map[string]any)["strokeId"] = strings.Repeat("x", 129)
			},
		},
		{
			name: "oversized color",
			mutate: func(event map[string]any) {
				event["payload"].(map[string]any)["color"] = strings.Repeat("é", 33)
			},
		},
		{
			name: "expiry beyond horizon",
			mutate: func(event map[string]any) {
				payload := event["payload"].(map[string]any)
				payload["ephemeral"] = true
				payload["expiresAt"] = float64(61_001)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event := validRelayEventMap()
			tt.mutate(event)
			data, err := json.Marshal(event)
			if err != nil {
				t.Fatalf("marshal event: %v", err)
			}
			if _, ok := parseRelayEvent(data); ok {
				t.Fatal("accepted event beyond the relay protocol limit")
			}
		})
	}
}

func TestParseRelayEventRejectsNonJPEGBackground(t *testing.T) {
	t.Parallel()

	event := validRelayEventMap()
	event["type"] = "board:set-background"
	event["payload"] = map[string]any{
		"background": map[string]any{
			"kind":    "image",
			"dataUrl": "data:image/svg+xml,<svg/>",
			"width":   float64(1),
			"height":  float64(1),
		},
	}
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	if _, ok := parseRelayEvent(data); ok {
		t.Fatal("accepted a non-JPEG background")
	}
}

func TestParseRelayEventRejectsRestoreStateLimits(t *testing.T) {
	t.Parallel()

	stroke := validRestoredStroke("stroke-1", 1)
	tests := []struct {
		name    string
		strokes []any
	}{
		{
			name: "duplicate stroke IDs",
			strokes: []any{
				stroke,
				validRestoredStroke("stroke-1", 1),
			},
		},
		{
			name:    "per-stroke point overflow",
			strokes: []any{validRestoredStroke("stroke-large", maxRelayPointsPerStroke+1)},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event := validRelayEventMap()
			event["type"] = "board:restore"
			event["payload"] = map[string]any{
				"surface": "whiteboard",
				"strokes": tt.strokes,
				"pointer": map[string]any{"visible": false, "point": nil},
			}
			data, err := json.Marshal(event)
			if err != nil {
				t.Fatalf("marshal restore: %v", err)
			}
			if _, ok := parseRelayEvent(data); ok {
				t.Fatal("accepted restore beyond the state limits")
			}
		})
	}
}

func validRestoredStroke(id string, pointCount int) map[string]any {
	points := make([]any, pointCount)
	for index := range points {
		points[index] = map[string]any{"x": 0.1, "y": 0.2}
	}
	return map[string]any{
		"strokeId": id,
		"surface":  "whiteboard",
		"tool":     "marker",
		"color":    "#111111",
		"width":    float64(3),
		"points":   points,
		"complete": true,
	}
}

func validRelayEventMap() map[string]any {
	return map[string]any{
		"id":      "evt-valid",
		"type":    "stroke:start",
		"boardId": "default",
		"at":      float64(1_000),
		"payload": map[string]any{
			"strokeId": "stroke-valid",
			"surface":  "whiteboard",
			"tool":     "marker",
			"color":    "#111111",
			"width":    float64(3),
			"point":    map[string]any{"x": 0.1, "y": 0.2},
		},
	}
}

func TestConnectionGateEnforcesPerSourceAndGlobalLimits(t *testing.T) {
	t.Parallel()

	gate := newConnectionGate()
	var releases []func()
	for index := 0; index < 64; index++ {
		release, ok := gate.acquire("192.168.1.10:1234")
		if !ok {
			t.Fatalf("per-source connection %d rejected", index+1)
		}
		releases = append(releases, release)
	}
	if _, ok := gate.acquire("192.168.1.10:9999"); ok {
		t.Fatal("65th connection for one source accepted")
	}
	for index := 0; index < 64; index++ {
		release, ok := gate.acquire("192.168.1.11:1234")
		if !ok {
			t.Fatalf("global connection %d rejected before 128", index+65)
		}
		releases = append(releases, release)
	}
	if _, ok := gate.acquire("192.168.1.12:1234"); ok {
		t.Fatal("129th global connection accepted")
	}

	for _, release := range releases {
		release()
		release()
	}
	if gate.total != 0 || len(gate.bySource) != 0 {
		t.Fatalf("gate counters after release = total %d, sources %#v", gate.total, gate.bySource)
	}
}

func TestRelayEndpointReturnsServiceUnavailableWhenGateIsFull(t *testing.T) {
	t.Parallel()

	gate := newConnectionGate()
	for index := 0; index < 64; index++ {
		if _, ok := gate.acquire("192.168.1.10:1234"); !ok {
			t.Fatal("failed to fill first source")
		}
		if _, ok := gate.acquire("192.168.1.11:1234"); !ok {
			t.Fatal("failed to fill second source")
		}
	}

	handler := relayEndpoint(hub.New(), "", gate, time.Second, time.Second)
	request := httptest.NewRequest(http.MethodGet, "/ws/relay", nil)
	request.RemoteAddr = "192.168.1.12:1234"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("overflow status = %d, want 503", recorder.Code)
	}
}
