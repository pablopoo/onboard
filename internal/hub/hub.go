package hub

import (
	"sync"
	"time"
)

const (
	subscriberBufferSize = 64
	recentEventIDLimit   = 8192
	RoleBoard            = "board"
	RoleViewer           = "viewer"
)

type Event struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	BoardID string         `json:"boardId"`
	At      float64        `json:"at"`
	Payload map[string]any `json:"payload"`
}

type Hub struct {
	mu                  sync.Mutex
	events              []Event
	state               boardSnapshot
	appliedEventIDs     map[string]struct{}
	appliedEventIDOrder []string
	subscribers         map[*subscription]struct{}
	presenterActive     bool
}

type subscription struct {
	events    chan Event
	role      string
	closeOnce sync.Once
}

func New() *Hub {
	return &Hub{
		appliedEventIDs:     make(map[string]struct{}),
		appliedEventIDOrder: make([]string, 0, recentEventIDLimit),
		subscribers:         make(map[*subscription]struct{}),
		state:               newBoardSnapshot(),
	}
}

func (h *Hub) Record(event Event) {
	stored := cloneEvent(event)

	h.mu.Lock()
	if h.appliedEventIDs == nil {
		h.appliedEventIDs = make(map[string]struct{})
	}
	if stored.ID != "" {
		if _, exists := h.appliedEventIDs[stored.ID]; exists {
			h.mu.Unlock()
			return
		}
	}

	if !h.state.Apply(stored) {
		h.mu.Unlock()
		return
	}
	h.rememberAppliedEventID(stored.ID)
	h.events = []Event{h.state.RestoreEvent(stored)}

	var dropped []*subscription
	for subscriber := range h.subscribers {
		if shouldDropSlowSubscriberForEvent(subscriber, stored) {
			delete(h.subscribers, subscriber)
			dropped = append(dropped, subscriber)
			continue
		}

		select {
		case subscriber.events <- cloneEvent(stored):
		default:
			delete(h.subscribers, subscriber)
			dropped = append(dropped, subscriber)
		}
	}
	if len(dropped) > 0 {
		dropped = append(dropped, h.broadcastPresenceLocked()...)
	}
	h.mu.Unlock()

	closeSubscriptions(dropped)
}

func shouldDropSlowSubscriberForEvent(subscriber *subscription, event Event) bool {
	return subscriber.role == RoleViewer &&
		eventCarriesBackground(event) &&
		len(subscriber.events) > 0
}

func eventCarriesBackground(event Event) bool {
	if event.Type != "board:set-background" && event.Type != "board:restore" {
		return false
	}
	return event.Payload["background"] != nil
}

func (h *Hub) rememberAppliedEventID(id string) {
	if id == "" {
		return
	}
	if h.appliedEventIDs == nil {
		h.appliedEventIDs = make(map[string]struct{})
	}
	if _, exists := h.appliedEventIDs[id]; exists {
		return
	}

	h.appliedEventIDs[id] = struct{}{}
	h.appliedEventIDOrder = append(h.appliedEventIDOrder, id)
	if len(h.appliedEventIDOrder) <= recentEventIDLimit {
		return
	}

	oldest := h.appliedEventIDOrder[0]
	delete(h.appliedEventIDs, oldest)
	h.appliedEventIDOrder[0] = ""
	h.appliedEventIDOrder = h.appliedEventIDOrder[1:]
}

func (h *Hub) Snapshot() []Event {
	h.mu.Lock()
	defer h.mu.Unlock()

	snapshot := make([]Event, len(h.events))
	for index, event := range h.events {
		snapshot[index] = cloneEvent(event)
	}
	return snapshot
}

func (h *Hub) Subscribe() (<-chan Event, func()) {
	_, events, unsubscribe := h.SubscribeWithSnapshot()
	return events, unsubscribe
}

func (h *Hub) SubscribeWithSnapshot() ([]Event, <-chan Event, func()) {
	return h.SubscribeWithSnapshotRole("")
}

func (h *Hub) SubscribeWithSnapshotRole(role string) ([]Event, <-chan Event, func()) {
	subscriber := &subscription{
		events: make(chan Event, subscriberBufferSize),
		role:   role,
	}

	h.mu.Lock()
	snapshot := cloneEvents(h.events)
	h.subscribers[subscriber] = struct{}{}
	dropped := h.broadcastPresenceLocked()
	h.mu.Unlock()
	closeSubscriptions(dropped)

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			h.mu.Lock()
			if _, exists := h.subscribers[subscriber]; exists {
				delete(h.subscribers, subscriber)
				dropped = h.broadcastPresenceLocked()
			} else {
				dropped = nil
			}
			h.mu.Unlock()
			closeSubscriptions(dropped)
			subscriber.close()
		})
	}

	return snapshot, subscriber.events, unsubscribe
}

func (h *Hub) broadcastPresenceLocked() []*subscription {
	viewerCount := h.viewerCountLocked()
	event := Event{
		Type: "system:relay-presence",
		Payload: map[string]any{
			"viewerCount": viewerCount,
		},
	}

	var dropped []*subscription
	for subscriber := range h.subscribers {
		if subscriber.role != RoleBoard {
			continue
		}

		select {
		case subscriber.events <- cloneEvent(event):
		default:
			delete(h.subscribers, subscriber)
			dropped = append(dropped, subscriber)
		}
	}

	return dropped
}

func (h *Hub) viewerCountLocked() int {
	count := 0
	for subscriber := range h.subscribers {
		if subscriber.role == RoleViewer {
			count += 1
		}
	}
	return count
}

func (h *Hub) AcquirePresenter() bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.presenterActive {
		return false
	}
	h.presenterActive = true
	return true
}

func (h *Hub) ReleasePresenter() {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.presenterActive = false
}

func (s *subscription) close() {
	s.closeOnce.Do(func() {
		close(s.events)
	})
}

func closeSubscriptions(subscribers []*subscription) {
	for _, subscriber := range subscribers {
		subscriber.close()
	}
}

func cloneEvent(event Event) Event {
	return Event{
		ID:      event.ID,
		Type:    event.Type,
		BoardID: event.BoardID,
		At:      event.At,
		Payload: clonePayload(event.Payload),
	}
}

type boardSnapshot struct {
	surface    string
	background map[string]any
	strokes    []map[string]any
	active     map[string]int
	pointer    map[string]any
}

func newBoardSnapshot() boardSnapshot {
	return boardSnapshot{
		surface: "whiteboard",
		active:  make(map[string]int),
		pointer: hiddenPointer(),
	}
}

func (s *boardSnapshot) Apply(event Event) bool {
	s.ensureDefaults()
	payload := event.Payload

	switch event.Type {
	case "board:set-surface":
		if surface, ok := payload["surface"].(string); ok && surface != "" {
			s.surface = surface
		}
	case "board:set-background":
		if payload["background"] == nil {
			s.background = nil
			break
		}
		background, ok := payload["background"].(map[string]any)
		if !ok {
			return false
		}
		s.background = clonePayload(background)
	case "stroke:start":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok {
			return false
		}
		stroke := map[string]any{
			"strokeId": strokeID,
			"surface":  cloneValue(payload["surface"]),
			"tool":     cloneValue(payload["tool"]),
			"color":    cloneValue(payload["color"]),
			"width":    cloneValue(payload["width"]),
			"points":   []any{cloneValue(payload["point"])},
			"complete": false,
		}
		if value, ok := payload["ephemeral"]; ok {
			stroke["ephemeral"] = cloneValue(value)
		}
		if value, ok := payload["expiresAt"]; ok {
			stroke["expiresAt"] = cloneValue(value)
		}
		s.strokes = append(s.strokes, stroke)
		s.rebuildActive()
	case "stroke:point":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok {
			return false
		}
		index, ok := s.active[strokeID]
		if !ok || index < 0 || index >= len(s.strokes) {
			return false
		}
		points, _ := s.strokes[index]["points"].([]any)
		s.strokes[index]["points"] = append(points, cloneValue(payload["point"]))
	case "stroke:end":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok {
			return false
		}
		index, ok := s.active[strokeID]
		if !ok || index < 0 || index >= len(s.strokes) {
			return false
		}
		s.strokes[index]["complete"] = true
		delete(s.active, strokeID)
	case "stroke:expire":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok {
			return false
		}
		if !s.removeStroke(strokeID, true) {
			return false
		}
	case "board:undo":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok {
			return false
		}
		if !s.removeStroke(strokeID, false) {
			return false
		}
	case "board:restore":
		s.restore(payload)
	case "board:clear":
		s.background = nil
		s.strokes = nil
		s.active = make(map[string]int)
		s.pointer = hiddenPointer()
	case "pointer:show", "pointer:move":
		s.pointer = map[string]any{
			"visible": true,
			"point":   cloneValue(payload["point"]),
		}
	case "pointer:hide":
		s.pointer = hiddenPointer()
	default:
		return false
	}

	return true
}

func (s *boardSnapshot) RestoreEvent(source Event) Event {
	return Event{
		ID:      source.ID,
		Type:    "board:restore",
		BoardID: source.BoardID,
		At:      source.At,
		Payload: map[string]any{
			"surface":    s.surface,
			"background": cloneOptionalPayload(s.background),
			"strokes": s.currentStrokes(
				float64(time.Now().UnixMilli()),
			),
			"pointer": clonePayload(s.pointer),
		},
	}
}

func (s *boardSnapshot) ensureDefaults() {
	if s.surface == "" {
		s.surface = "whiteboard"
	}
	if s.active == nil {
		s.active = make(map[string]int)
	}
	if s.pointer == nil {
		s.pointer = hiddenPointer()
	}
}

func (s *boardSnapshot) restore(payload map[string]any) {
	if surface, ok := payload["surface"].(string); ok && surface != "" {
		s.surface = surface
	} else {
		s.surface = "whiteboard"
	}

	s.strokes = nil
	for _, value := range sliceValues(payload["strokes"]) {
		stroke, ok := value.(map[string]any)
		if !ok {
			continue
		}
		s.strokes = append(s.strokes, clonePayload(stroke))
	}

	if pointer, ok := payload["pointer"].(map[string]any); ok {
		s.pointer = clonePayload(pointer)
	} else {
		s.pointer = hiddenPointer()
	}
	if background, ok := payload["background"].(map[string]any); ok {
		s.background = clonePayload(background)
	} else {
		s.background = nil
	}
	s.rebuildActive()
}

func (s *boardSnapshot) currentStrokes(nowMillis float64) []any {
	strokes := make([]any, 0, len(s.strokes))
	for _, stroke := range s.strokes {
		if strokeExpired(stroke, nowMillis) {
			continue
		}
		strokes = append(strokes, clonePayload(stroke))
	}
	return strokes
}

func (s *boardSnapshot) removeStroke(strokeID string, ephemeralOnly bool) bool {
	filtered := s.strokes[:0]
	removed := false
	for _, stroke := range s.strokes {
		currentID, _ := stroke["strokeId"].(string)
		ephemeral, _ := stroke["ephemeral"].(bool)
		if currentID == strokeID && (!ephemeralOnly || ephemeral) {
			removed = true
			continue
		}
		filtered = append(filtered, stroke)
	}
	if !removed {
		return false
	}
	s.strokes = filtered
	s.rebuildActive()
	return true
}

func (s *boardSnapshot) rebuildActive() {
	s.active = make(map[string]int)
	for index, stroke := range s.strokes {
		strokeID, _ := stroke["strokeId"].(string)
		complete, _ := stroke["complete"].(bool)
		if strokeID != "" && !complete {
			s.active[strokeID] = index
		}
	}
}

func hiddenPointer() map[string]any {
	return map[string]any{
		"visible": false,
		"point":   nil,
	}
}

func payloadString(payload map[string]any, key string) (string, bool) {
	value, ok := payload[key].(string)
	return value, ok && value != ""
}

func sliceValues(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	case []map[string]any:
		values := make([]any, len(typed))
		for index, item := range typed {
			values[index] = item
		}
		return values
	default:
		return nil
	}
}

func strokeExpired(stroke map[string]any, nowMillis float64) bool {
	ephemeral, _ := stroke["ephemeral"].(bool)
	if !ephemeral {
		return false
	}
	expiresAt, ok := numberValue(stroke["expiresAt"])
	return ok && nowMillis >= expiresAt
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	default:
		return 0, false
	}
}

func cloneEvents(events []Event) []Event {
	cloned := make([]Event, len(events))
	for index, event := range events {
		cloned[index] = cloneEvent(event)
	}
	return cloned
}

func clonePayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}

	cloned := make(map[string]any, len(payload))
	for key, value := range payload {
		cloned[key] = cloneValue(value)
	}
	return cloned
}

func cloneOptionalPayload(payload map[string]any) any {
	if payload == nil {
		return nil
	}
	return clonePayload(payload)
}

func cloneValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return clonePayload(typed)
	case []any:
		cloned := make([]any, len(typed))
		for index, item := range typed {
			cloned[index] = cloneValue(item)
		}
		return cloned
	case []map[string]any:
		cloned := make([]any, len(typed))
		for index, item := range typed {
			cloned[index] = clonePayload(item)
		}
		return cloned
	default:
		return typed
	}
}
