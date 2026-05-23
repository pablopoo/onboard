package hub_test

import (
	"reflect"
	"strconv"
	"testing"
	"time"

	"onboard/internal/hub"
)

func TestRecordCompactsSnapshotToRestoreEvent(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	event := strokeStartEvent("evt-1", "stroke-1")

	relay.Record(event)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-1", "whiteboard", []string{"stroke-1"})
}

func TestRecordSnapshotFollowsCurrentStateWithoutLongReplay(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	relay.Record(surfaceEvent("evt-1", "greenboard"))
	relay.Record(strokeStartEvent("evt-2", "stroke-1"))
	relay.Record(strokePointEvent("evt-3", "stroke-1", 0.4, 0.5))
	relay.Record(strokeEndEvent("evt-4", "stroke-1"))
	relay.Record(strokeStartEvent("evt-5", "stroke-2"))
	relay.Record(strokeEndEvent("evt-6", "stroke-2"))
	relay.Record(undoEvent("evt-7", "stroke-2"))

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want compact restore event", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-7", "greenboard", []string{"stroke-1"})
}

func TestRecordIgnoresDuplicateEventIDs(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	event := strokeStartEvent("evt-1", "stroke-1")

	events, unsubscribe := relay.Subscribe()
	defer unsubscribe()

	relay.Record(event)
	relay.Record(event)

	assertNextEvent(t, events, event)
	assertNoEvent(t, events)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-1", "whiteboard", []string{"stroke-1"})
}

func TestRecordIgnoresUnappliedEventsWithoutBurningID(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	point := strokePointEvent("evt-point", "stroke-1", 0.4, 0.5)

	events, unsubscribe := relay.Subscribe()
	defer unsubscribe()

	relay.Record(point)

	assertNoEvent(t, events)
	if snapshot := relay.Snapshot(); len(snapshot) != 0 {
		t.Fatalf("snapshot length = %d, want 0 after unapplied point: %#v", len(snapshot), snapshot)
	}

	start := strokeStartEvent("evt-start", "stroke-1")
	relay.Record(start)
	relay.Record(point)

	assertNextEvent(t, events, start)
	assertNextEvent(t, events, point)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-point", "whiteboard", []string{"stroke-1"})
}

func TestRecordIgnoresNoOpLifecycleEventsWithoutBurningID(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	expire := expireEvent("evt-expire", "late-ephemeral")
	undo := undoEvent("evt-undo", "late-undo")

	events, unsubscribe := relay.Subscribe()
	defer unsubscribe()

	relay.Record(expire)
	relay.Record(undo)

	assertNoEvent(t, events)
	if snapshot := relay.Snapshot(); len(snapshot) != 0 {
		t.Fatalf("snapshot length = %d, want 0 after no-op lifecycle events: %#v", len(snapshot), snapshot)
	}

	ephemeral := strokeStartEvent("evt-start-ephemeral", "late-ephemeral")
	ephemeral.Payload["ephemeral"] = true
	ephemeral.Payload["expiresAt"] = float64(time.Now().Add(time.Hour).UnixMilli())
	startUndo := strokeStartEvent("evt-start-undo", "late-undo")
	relay.Record(ephemeral)
	relay.Record(startUndo)
	relay.Record(expire)
	relay.Record(undo)

	assertNextEvent(t, events, ephemeral)
	assertNextEvent(t, events, startUndo)
	assertNextEvent(t, events, expire)
	assertNextEvent(t, events, undo)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-undo", "whiteboard", nil)
}

func TestRecordCopiesPayload(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	event := strokeStartEvent("evt-1", "stroke-1")
	event.Payload["color"] = "black"
	event.Payload["point"] = map[string]any{"x": 0.25, "y": 0.75}

	relay.Record(event)
	event.Payload["color"] = "red"
	event.Payload["point"].(map[string]any)["x"] = 1.0

	snapshot := relay.Snapshot()
	snapshotStrokes := snapshot[0].Payload["strokes"].([]any)
	snapshotStroke := snapshotStrokes[0].(map[string]any)
	snapshotStroke["color"] = "blue"
	snapshotStroke["points"].([]any)[0].(map[string]any)["x"] = 0.5
	snapshot = append(snapshot, testEvent("evt-2", "stroke:end"))

	nextSnapshot := relay.Snapshot()
	if len(nextSnapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(nextSnapshot))
	}
	strokes := nextSnapshot[0].Payload["strokes"].([]any)
	stroke := strokes[0].(map[string]any)
	if got := stroke["color"]; got != "black" {
		t.Fatalf("stored color = %v, want black", got)
	}
	point := stroke["points"].([]any)[0].(map[string]any)
	if got := point["x"]; got != 0.25 {
		t.Fatalf("stored point x = %v, want 0.25", got)
	}
}

func TestRecordClearResetsReplayBaseline(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	relay.Record(strokeStartEvent("evt-1", "stroke-1"))
	relay.Record(strokeEndEvent("evt-2", "stroke-1"))

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
	assertRestoreEvent(t, snapshot[0], "evt-3", "whiteboard", nil)

	afterClear := strokeStartEvent("evt-4", "stroke-2")
	relay.Record(afterClear)

	snapshot = relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length after new event = %d, want compact restore event", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-4", "whiteboard", []string{"stroke-2"})
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
	relay.Record(strokeStartEvent("evt-2", "stroke-1"))
	relay.Record(greenboard)
	relay.Record(strokeEndEvent("evt-4", "stroke-1"))
	relay.Record(clear)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want compact restore event", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-5", "greenboard", nil)
}

func TestRecordBackgroundIsIncludedInRestoreSnapshot(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	background := hub.Event{
		ID:      "evt-background",
		Type:    "board:set-background",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"background": map[string]any{
				"kind":    "image",
				"dataUrl": "data:image/jpeg;base64,abc123",
				"width":   float64(1280),
				"height":  float64(720),
			},
		},
	}

	relay.Record(background)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	got, ok := snapshot[0].Payload["background"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot background = %#v, want object", snapshot[0].Payload["background"])
	}
	if got["dataUrl"] != "data:image/jpeg;base64,abc123" {
		t.Fatalf("snapshot background dataUrl = %v, want captured data URL", got["dataUrl"])
	}

	relay.Record(hub.Event{
		ID:      "evt-clear",
		Type:    "board:clear",
		BoardID: "board-1",
		At:      200,
		Payload: map[string]any{},
	})
	snapshot = relay.Snapshot()
	if snapshot[0].Payload["background"] != nil {
		t.Fatalf("snapshot background after clear = %#v, want nil", snapshot[0].Payload["background"])
	}
}

func TestRecordRestoreResetsReplayBaseline(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	relay.Record(strokeStartEvent("evt-1", "stroke-1"))
	relay.Record(strokeEndEvent("evt-2", "stroke-1"))

	restore := hub.Event{
		ID:      "evt-3",
		Type:    "board:restore",
		BoardID: "board-1",
		At:      300,
		Payload: map[string]any{
			"surface": "greenboard",
			"strokes": []any{
				map[string]any{
					"strokeId": "stroke-restored",
					"surface":  "greenboard",
					"tool":     "chalk",
					"color":    "#ffffff",
					"width":    float64(5),
					"points": []any{
						map[string]any{"x": 0.1, "y": 0.2, "pressure": 0},
					},
					"complete": true,
				},
			},
			"pointer": map[string]any{"visible": false, "point": nil},
		},
	}
	relay.Record(restore)

	snapshot := relay.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-3", "greenboard", []string{"stroke-restored"})
}

func TestSubscribeReceivesEventsRecordedAfterSubscription(t *testing.T) {
	t.Parallel()

	relay := hub.New()
	relay.Record(strokeStartEvent("evt-before", "stroke-before"))

	events, unsubscribe := relay.Subscribe()
	defer unsubscribe()

	after := strokePointEvent("evt-after", "stroke-before", 0.4, 0.5)
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
	before := strokeStartEvent("evt-before", "stroke-before")
	relay.Record(before)

	snapshot, events, unsubscribe := relay.SubscribeWithSnapshot()
	defer unsubscribe()

	if len(snapshot) != 1 {
		t.Fatalf("snapshot length = %d, want 1", len(snapshot))
	}
	assertRestoreEvent(t, snapshot[0], "evt-before", "whiteboard", []string{"stroke-before"})

	after := strokePointEvent("evt-after", "stroke-before", 0.4, 0.5)
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
		relay.Record(surfaceEvent("evt-fill-"+strconv.Itoa(index), "whiteboard"))
	}

	recordDone := make(chan struct{})
	go func() {
		relay.Record(surfaceEvent("evt-overflow", "greenboard"))
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

func TestPresenterLockAllowsOnlyOneActivePresenter(t *testing.T) {
	t.Parallel()

	relay := hub.New()

	if !relay.AcquirePresenter() {
		t.Fatal("first presenter acquire failed")
	}
	if relay.AcquirePresenter() {
		t.Fatal("second presenter acquire succeeded while presenter active")
	}

	relay.ReleasePresenter()
	if !relay.AcquirePresenter() {
		t.Fatal("presenter acquire failed after release")
	}
	relay.ReleasePresenter()
}

func assertRestoreEvent(t *testing.T, event hub.Event, wantID string, wantSurface string, wantStrokeIDs []string) {
	t.Helper()

	if event.ID != wantID {
		t.Fatalf("snapshot ID = %q, want %q", event.ID, wantID)
	}
	if event.Type != "board:restore" {
		t.Fatalf("snapshot type = %q, want board:restore", event.Type)
	}
	if event.Payload["surface"] != wantSurface {
		t.Fatalf("snapshot surface = %v, want %q", event.Payload["surface"], wantSurface)
	}
	pointer, ok := event.Payload["pointer"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot pointer = %#v, want object", event.Payload["pointer"])
	}
	if pointer["visible"] != false || pointer["point"] != nil {
		t.Fatalf("snapshot pointer = %#v, want hidden pointer", pointer)
	}

	strokes, ok := event.Payload["strokes"].([]any)
	if !ok {
		t.Fatalf("snapshot strokes = %#v, want array", event.Payload["strokes"])
	}
	if len(strokes) != len(wantStrokeIDs) {
		t.Fatalf("snapshot strokes length = %d, want %d", len(strokes), len(wantStrokeIDs))
	}
	for index, wantStrokeID := range wantStrokeIDs {
		stroke, ok := strokes[index].(map[string]any)
		if !ok {
			t.Fatalf("snapshot stroke[%d] = %#v, want object", index, strokes[index])
		}
		if stroke["strokeId"] != wantStrokeID {
			t.Fatalf("snapshot stroke[%d] ID = %v, want %q", index, stroke["strokeId"], wantStrokeID)
		}
	}
}

func assertNextEvent(t *testing.T, events <-chan hub.Event, want hub.Event) {
	t.Helper()

	select {
	case got := <-events:
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("subscribed event = %#v, want %#v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscribed event")
	}
}

func assertNoEvent(t *testing.T, events <-chan hub.Event) {
	t.Helper()

	select {
	case got, ok := <-events:
		if !ok {
			t.Fatal("subscription closed while checking for duplicate event")
		}
		t.Fatalf("unexpected subscribed event: %#v", got)
	case <-time.After(150 * time.Millisecond):
	}
}

func surfaceEvent(id string, surface string) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    "board:set-surface",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"surface": surface,
		},
	}
}

func strokeStartEvent(id string, strokeID string) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    "stroke:start",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": strokeID,
			"surface":  "whiteboard",
			"tool":     "marker",
			"color":    "#111111",
			"width":    float64(4),
			"point":    map[string]any{"x": 0.25, "y": 0.5, "pressure": 0},
		},
	}
}

func strokePointEvent(id string, strokeID string, x float64, y float64) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    "stroke:point",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": strokeID,
			"point":    map[string]any{"x": x, "y": y, "pressure": 0},
		},
	}
}

func strokeEndEvent(id string, strokeID string) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    "stroke:end",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": strokeID,
		},
	}
}

func undoEvent(id string, strokeID string) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    "board:undo",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": strokeID,
		},
	}
}

func expireEvent(id string, strokeID string) hub.Event {
	return hub.Event{
		ID:      id,
		Type:    "stroke:expire",
		BoardID: "board-1",
		At:      100,
		Payload: map[string]any{
			"strokeId": strokeID,
		},
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
