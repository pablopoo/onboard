package hub_test

import (
	"reflect"
	"strconv"
	"testing"
	"time"

	"onboard/internal/hub"
)

func TestRecordAppendsEvent(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	event := testEvent("evt-1", "stroke:start")

	relay.Record(event)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	if !reflect.DeepEqual(snapshot[0], event) {
		t.Fatalf("snapshot[0] = %#v, want %#v", snapshot[0], event)
	}
}

func TestRecordCopiesPayload(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	event := hub.Event{
		ID:      "evt-1",
		Type:    "stroke:start",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"color": "black",
			"point": map[string]any{
				"x": 0.25,
				"y": 0.75,
			},
		},
	}

	relay.Record(event)
	event.Payload["color"] = "red"
	event.Payload["point"].(map[string]any)["x"] = 1.0

	snapshot := relay.Snapshot()
	snapshot[0].Payload["color"] = "blue"
	snapshot[0].Payload["point"].(map[string]any)["x"] = 0.5
	snapshot = append(snapshot, testEvent("evt-2", "stroke:end"))

	nextSnapshot := relay.Snapshot()
	if len(nextSnapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(nextSnapshot))
	}
	if got := nextSnapshot[0].Payload["color"]; got != "black" {
		t.Fatalf("stored color = %v, want black", got)
	}
	point := nextSnapshot[0].Payload["point"].(map[string]any)
	if got := point["x"]; got != 0.25 {
		t.Fatalf("stored point x = %v, want 0.25", got)
	}
}

func TestRecordClearResetsReplayBaseline(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	relay.Record(testEvent("evt-1", "stroke:start"))
	relay.Record(testEvent("evt-2", "stroke:end"))

	clear := hub.Event{
		ID:      "evt-3",
		Type:    "board:clear",
		BoardID: "board-1",
		At:      300,
		Payload: map[string]any{},
	}
	relay.Record(clear)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	if !reflect.DeepEqual(snapshot[0], clear) {
		t.Fatalf("snapshot[0] = %#v, want clear %#v", snapshot[0], clear)
	}

	afterClear := testEvent("evt-4", "stroke:start")
	relay.Record(afterClear)

	snapshot = relay.Snapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot length after new event = %d, want 2", len(snapshot))
	}
	if !reflect.DeepEqual(snapshot[0], clear) {
		t.Fatalf("snapshot[0] = %#v, want clear %#v", snapshot[0], clear)
	}
	if !reflect.DeepEqual(snapshot[1], afterClear) {
		t.Fatalf("snapshot[1] = %#v, want %#v", snapshot[1], afterClear)
	}
}

func TestRecordClearPreservesLatestSurfaceBaseline(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	whiteboard := hub.Event{
		ID:      "evt-1",
		Type:    "board:set-surface",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{"surface": "whiteboard"},
	}
	greenboard := hub.Event{
		ID:      "evt-3",
		Type:    "board:set-surface",
		BoardID: "board-1",
		At:      300,
		Payload: map[string]any{"surface": "greenboard"},
	}
	clear := hub.Event{
		ID:      "evt-5",
		Type:    "board:clear",
		BoardID: "board-1",
		At:      500,
		Payload: map[string]any{},
	}

	relay.Record(whiteboard)
	relay.Record(testEvent("evt-2", "stroke:start"))
	relay.Record(greenboard)
	relay.Record(testEvent("evt-4", "stroke:end"))
	relay.Record(clear)

	snapshot := relay.Snapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot length = %d, want 2", len(snapshot))
	}
	if !reflect.DeepEqual(snapshot[0], greenboard) {
		t.Fatalf("snapshot[0] = %#v, want latest surface %#v", snapshot[0], greenboard)
	}
	if !reflect.DeepEqual(snapshot[1], clear) {
		t.Fatalf("snapshot[1] = %#v, want clear %#v", snapshot[1], clear)
	}
}

func TestSubscribeReceivesEventsRecordedAfterSubscription(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	relay.Record(testEvent("evt-before", "stroke:start"))

	events, unsubscribe := relay.Subscribe()
	defer unsubscribe()

	after := testEvent("evt-after", "stroke:point")
	relay.Record(after)

	select {
	case got := <-events:
		if !reflect.DeepEqual(got, after) {
			t.Fatalf("subscribed event = %#v, want %#v", got, after)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscribed event")
	}
}

func TestSubscribeWithSnapshotReturnsSnapshotAndLaterEvents(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	before := testEvent("evt-before", "stroke:start")
	relay.Record(before)

	snapshot, events, unsubscribe := relay.SubscribeWithSnapshot()
	defer unsubscribe()

	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	if !reflect.DeepEqual(snapshot[0], before) {
		t.Fatalf("snapshot[0] = %#v, want %#v", snapshot[0], before)
	}

	after := testEvent("evt-after", "stroke:point")
	relay.Record(after)

	select {
	case got := <-events:
		if !reflect.DeepEqual(got, after) {
			t.Fatalf("subscribed event = %#v, want %#v", got, after)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscribed event")
	}
}

func TestFullSubscriberQueueDoesNotBlockRecordAndDropsSubscriber(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	_, events, unsubscribe := relay.SubscribeWithSnapshot()
	defer unsubscribe()

	queueCapacity := cap(events)
	if queueCapacity == 0 {
		t.Fatal("subscriber channel must be bounded with capacity")
	}

	for index := 0; index < queueCapacity; index++ {
		relay.Record(testEvent("evt-fill-"+strconv.Itoa(index), "stroke:point"))
	}

	recordDone := make(chan struct{})
	go func() {
		relay.Record(testEvent("evt-overflow", "stroke:point"))
		close(recordDone)
	}()

	select {
	case <-recordDone:
	case <-time.After(time.Second):
		t.Fatal("Record blocked on a full subscriber queue")
	}

	received := 0
	for {
		select {
		case _, ok := <-events:
			if !ok {
				if received != queueCapacity {
					t.Fatalf("received %d queued events before close, want %d", received, queueCapacity)
				}
				return
			}
			received++
			if received > queueCapacity {
				t.Fatalf("received %d events, slow subscriber should have been dropped before overflow delivery", received)
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for dropped subscriber channel to close")
		}
	}
}

func testEvent(id string, eventType string) hub.Event {
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
