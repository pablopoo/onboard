package hub

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestRecentEventIDTrackingIsBounded(t *testing.T) {
	t.Parallel()

	relay := New()
	eventCount := recentEventIDLimit + 100

	for index := 0; index < eventCount; index++ {
		relay.Record(testSurfaceEvent(fmt.Sprintf("evt-%d", index)))
	}

	if len(relay.appliedEventIDs) != recentEventIDLimit {
		t.Fatalf("tracked ID count = %d, want %d", len(relay.appliedEventIDs), recentEventIDLimit)
	}
	if len(relay.appliedEventIDOrder) != recentEventIDLimit {
		t.Fatalf("tracked ID order length = %d, want %d", len(relay.appliedEventIDOrder), recentEventIDLimit)
	}
	if _, ok := relay.appliedEventIDs["evt-0"]; ok {
		t.Fatal("oldest event ID was not evicted")
	}
	newest := fmt.Sprintf("evt-%d", eventCount-1)
	if _, ok := relay.appliedEventIDs[newest]; !ok {
		t.Fatalf("newest event ID %q was not retained", newest)
	}
}

func TestRecordStoresDeltaMetadataAndBuildsSnapshotOnDemand(t *testing.T) {
	t.Parallel()

	relay := New()
	event := Event{
		ID:      "evt-start",
		Type:    "stroke:start",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": "stroke-1",
			"surface":  "whiteboard",
			"tool":     "marker",
			"color":    "#111111",
			"width":    float64(4),
			"point":    map[string]any{"x": 0.25, "y": 0.5, "pressure": 0},
		},
	}

	if !relay.Record(event) {
		t.Fatal("record rejected")
	}
	if relay.lastEvent.Type != "stroke:start" {
		t.Fatalf("stored event type = %q, want delta stroke:start", relay.lastEvent.Type)
	}
	if !relay.hasState {
		t.Fatal("hub did not mark canonical state as initialized")
	}

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 || snapshot[0].Type != "board:restore" {
		t.Fatalf("snapshot = %#v, want one on-demand restore", snapshot)
	}
}

func TestBoardSnapshotAccountingMatchesSerializedState(t *testing.T) {
	t.Parallel()

	relay := New()
	relay.Record(Event{
		ID:      "evt-start",
		Type:    "stroke:start",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": "stroke-1",
			"surface":  "whiteboard",
			"tool":     "marker",
			"color":    "#111111",
			"width":    float64(4),
			"point":    map[string]any{"x": 0.25, "y": 0.5, "pressure": 0},
		},
	})
	relay.Record(Event{
		ID:      "evt-point",
		Type:    "stroke:point",
		BoardID: "board-1",
		At:      101,
		Payload: map[string]any{
			"strokeId": "stroke-1",
			"point":    map[string]any{"x": 0.4, "y": 0.6, "pressure": 0},
		},
	})

	relay.mu.Lock()
	payload := map[string]any{
		"surface":    relay.state.surface,
		"background": cloneOptionalPayload(relay.state.background),
		"strokes":    cloneStrokeValues(relay.state.strokes),
		"pointer":    clonePayload(relay.state.pointer),
	}
	data, err := json.Marshal(payload)
	got := relay.state.retainedBytes
	relay.mu.Unlock()
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	if got != len(data) {
		t.Fatalf("retained bytes = %d, want serialized size %d", got, len(data))
	}
}

func testSurfaceEvent(id string) Event {
	return Event{
		ID:      id,
		Type:    "board:set-surface",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"surface": "whiteboard",
		},
	}
}

func BenchmarkRecordStrokePoint(b *testing.B) {
	for _, pointCount := range []int{100, 1_000, 10_000} {
		b.Run(fmt.Sprintf("retained_points_%d", pointCount), func(b *testing.B) {
			b.ReportAllocs()
			for index := 0; index < b.N; index++ {
				b.StopTimer()
				relay, activeStrokeID := benchmarkHubWithPoints(pointCount)
				event := Event{
					ID:      "evt-benchmark-point",
					Type:    "stroke:point",
					BoardID: "board-1",
					At:      100,
					Payload: map[string]any{
						"strokeId": activeStrokeID,
						"point":    map[string]any{"x": 0.4, "y": 0.6, "pressure": 0},
					},
				}
				b.StartTimer()
				if !relay.Record(event) {
					b.Fatal("benchmark point rejected")
				}
			}
		})
	}
}

func benchmarkHubWithPoints(pointCount int) (*Hub, string) {
	strokes := make([]any, 0, (pointCount+maxPointsPerStroke-1)/maxPointsPerStroke)
	remaining := pointCount
	for strokeIndex := 0; remaining > 0; strokeIndex++ {
		count := min(remaining, maxPointsPerStroke)
		points := make([]any, count)
		for pointIndex := range points {
			points[pointIndex] = map[string]any{"x": 0.1, "y": 0.2, "pressure": 0}
		}
		strokes = append(strokes, map[string]any{
			"strokeId": fmt.Sprintf("stroke-%d", strokeIndex),
			"surface":  "whiteboard",
			"tool":     "marker",
			"color":    "#111111",
			"width":    float64(4),
			"points":   points,
			"complete": remaining > count,
		})
		remaining -= count
	}

	relay := New()
	relay.Record(Event{
		ID:      "evt-restore",
		Type:    "board:restore",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"surface": "whiteboard",
			"strokes": strokes,
			"pointer": map[string]any{"visible": false, "point": nil},
		},
	})
	return relay, fmt.Sprintf("stroke-%d", len(strokes)-1)
}
