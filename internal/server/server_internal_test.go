package server

import (
	"encoding/json"
	"strings"
	"testing"
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
