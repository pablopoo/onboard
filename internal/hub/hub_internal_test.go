package hub

import (
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
