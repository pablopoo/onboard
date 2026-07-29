package hub

import (
	"encoding/json"
	"sync"
	"time"
)

const (
	subscriberBufferSize = 64
	recentEventIDLimit   = 8192
	maxStrokes           = 4096
	maxPointsPerStroke   = 8192
	maxTotalPoints       = 65536
	maxStateBytes        = 7_500_000
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
	lastEvent           Event
	hasState            bool
	state               boardSnapshot
	appliedEventIDs     map[string]struct{}
	appliedEventIDOrder []string
	subscribers         map[*subscription]struct{}
	presenterOwner      string
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

func (h *Hub) Record(event Event) bool {
	stored := cloneEvent(event)

	h.mu.Lock()
	if h.appliedEventIDs == nil {
		h.appliedEventIDs = make(map[string]struct{})
	}
	if stored.ID != "" {
		if _, exists := h.appliedEventIDs[stored.ID]; exists {
			h.mu.Unlock()
			return false
		}
	}

	if !h.state.Apply(stored) {
		h.mu.Unlock()
		return false
	}
	h.rememberAppliedEventID(stored.ID)
	h.lastEvent = stored
	h.hasState = true

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
	return true
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

	return h.snapshotLocked()
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
	snapshot := h.snapshotLocked()
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

func (h *Hub) snapshotLocked() []Event {
	if !h.hasState {
		return nil
	}
	return []Event{h.state.RestoreEvent(h.lastEvent)}
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

func (h *Hub) AcquirePresenter(owner string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if owner == "" || h.presenterOwner != "" {
		return false
	}
	h.presenterOwner = owner
	return true
}

func (h *Hub) ReleasePresenter(owner string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if owner == "" || h.presenterOwner != owner {
		return false
	}
	h.presenterOwner = ""
	return true
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
	surface       string
	background    map[string]any
	strokes       []map[string]any
	active        map[string]int
	pointer       map[string]any
	strokeIDs     map[string]struct{}
	strokeBytes   map[string]int
	totalPoints   int
	retainedBytes int
}

func newBoardSnapshot() boardSnapshot {
	snapshot := boardSnapshot{
		surface: "whiteboard",
		active:  make(map[string]int),
		pointer: hiddenPointer(),
	}
	snapshot.rebuildAccounting()
	return snapshot
}

func (s *boardSnapshot) Apply(event Event) bool {
	s.ensureDefaults()
	payload := event.Payload

	switch event.Type {
	case "board:set-surface":
		if surface, ok := payload["surface"].(string); ok && surface != "" {
			retainedBytes := s.retainedBytes - jsonSize(s.surface) + jsonSize(surface)
			if retainedBytes > maxStateBytes {
				return false
			}
			s.surface = surface
			s.retainedBytes = retainedBytes
		}
	case "board:set-background":
		var background map[string]any
		if payload["background"] == nil {
			background = nil
		} else {
			value, ok := payload["background"].(map[string]any)
			if !ok {
				return false
			}
			background = clonePayload(value)
		}
		retainedBytes := s.retainedBytes - jsonSize(s.background) + jsonSize(background)
		if retainedBytes > maxStateBytes {
			return false
		}
		s.background = background
		s.retainedBytes = retainedBytes
	case "stroke:start":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok || len(s.strokes) >= maxStrokes || s.totalPoints >= maxTotalPoints {
			return false
		}
		if _, exists := s.strokeIDs[strokeID]; exists {
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
		strokeByteLength := jsonSize(stroke)
		retainedBytes := s.retainedBytes + strokeByteLength
		if len(s.strokes) > 0 {
			retainedBytes++
		}
		if retainedBytes > maxStateBytes {
			return false
		}
		s.strokes = append(s.strokes, stroke)
		s.active[strokeID] = len(s.strokes) - 1
		s.strokeIDs[strokeID] = struct{}{}
		s.strokeBytes[strokeID] = strokeByteLength
		s.totalPoints++
		s.retainedBytes = retainedBytes
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
		if len(points) >= maxPointsPerStroke || s.totalPoints >= maxTotalPoints {
			return false
		}
		point := cloneValue(payload["point"])
		pointBytes := jsonSize(point) + 1
		if s.retainedBytes+pointBytes > maxStateBytes {
			return false
		}
		s.strokes[index]["points"] = append(points, point)
		s.strokeBytes[strokeID] += pointBytes
		s.totalPoints++
		s.retainedBytes += pointBytes
	case "stroke:end":
		strokeID, ok := payloadString(payload, "strokeId")
		if !ok {
			return false
		}
		index, ok := s.active[strokeID]
		if !ok || index < 0 || index >= len(s.strokes) {
			return false
		}
		oldBytes := s.strokeBytes[strokeID]
		s.strokes[index]["complete"] = true
		newBytes := jsonSize(s.strokes[index])
		s.strokeBytes[strokeID] = newBytes
		s.retainedBytes += newBytes - oldBytes
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
		if !s.restore(payload) {
			return false
		}
	case "board:clear":
		s.background = nil
		s.strokes = nil
		s.active = make(map[string]int)
		s.pointer = hiddenPointer()
		s.rebuildAccounting()
	case "pointer:show", "pointer:move":
		pointer := map[string]any{
			"visible": true,
			"point":   cloneValue(payload["point"]),
		}
		retainedBytes := s.retainedBytes - jsonSize(s.pointer) + jsonSize(pointer)
		if retainedBytes > maxStateBytes {
			return false
		}
		s.pointer = pointer
		s.retainedBytes = retainedBytes
	case "pointer:hide":
		pointer := hiddenPointer()
		s.retainedBytes = s.retainedBytes - jsonSize(s.pointer) + jsonSize(pointer)
		s.pointer = pointer
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
		Payload: s.restorePayload(float64(time.Now().UnixMilli())),
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
	if s.strokeIDs == nil || s.strokeBytes == nil {
		s.rebuildAccounting()
	}
}

func (s *boardSnapshot) restore(payload map[string]any) bool {
	candidate := newBoardSnapshot()
	if surface, ok := payload["surface"].(string); ok && surface != "" {
		candidate.surface = surface
	} else {
		candidate.surface = "whiteboard"
	}

	candidate.strokes = nil
	for _, value := range sliceValues(payload["strokes"]) {
		stroke, ok := value.(map[string]any)
		if !ok {
			return false
		}
		candidate.strokes = append(candidate.strokes, clonePayload(stroke))
	}
	if len(candidate.strokes) > maxStrokes {
		return false
	}

	if pointer, ok := payload["pointer"].(map[string]any); ok {
		candidate.pointer = clonePayload(pointer)
	} else {
		candidate.pointer = hiddenPointer()
	}
	if background, ok := payload["background"].(map[string]any); ok {
		candidate.background = clonePayload(background)
	} else {
		candidate.background = nil
	}
	if !candidate.rebuildAccounting() {
		return false
	}
	candidate.rebuildActive()
	*s = candidate
	return true
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
	removedPointCount := 0
	for _, stroke := range s.strokes {
		currentID, _ := stroke["strokeId"].(string)
		ephemeral, _ := stroke["ephemeral"].(bool)
		if currentID == strokeID && (!ephemeralOnly || ephemeral) {
			removed = true
			if points, ok := stroke["points"].([]any); ok {
				removedPointCount = len(points)
			}
			continue
		}
		filtered = append(filtered, stroke)
	}
	if !removed {
		return false
	}
	removedStrokeBytes := s.strokeBytes[strokeID]
	separatorBytes := 0
	if len(s.strokes) > 1 {
		separatorBytes = 1
	}
	s.strokes = filtered
	delete(s.strokeIDs, strokeID)
	delete(s.strokeBytes, strokeID)
	s.totalPoints -= removedPointCount
	s.retainedBytes -= removedStrokeBytes + separatorBytes
	s.rebuildActive()
	return true
}

func (s *boardSnapshot) rebuildAccounting() bool {
	s.strokeIDs = make(map[string]struct{}, len(s.strokes))
	s.strokeBytes = make(map[string]int, len(s.strokes))
	s.totalPoints = 0
	for _, stroke := range s.strokes {
		strokeID, ok := payloadString(stroke, "strokeId")
		if !ok {
			return false
		}
		if _, exists := s.strokeIDs[strokeID]; exists {
			return false
		}
		points, ok := stroke["points"].([]any)
		if !ok || len(points) == 0 || len(points) > maxPointsPerStroke {
			return false
		}
		s.totalPoints += len(points)
		if s.totalPoints > maxTotalPoints {
			return false
		}
		s.strokeIDs[strokeID] = struct{}{}
		s.strokeBytes[strokeID] = jsonSize(stroke)
	}
	s.retainedBytes = jsonSize(map[string]any{
		"surface":    s.surface,
		"background": cloneOptionalPayload(s.background),
		"strokes":    cloneStrokeValues(s.strokes),
		"pointer":    clonePayload(s.pointer),
	})
	return s.retainedBytes <= maxStateBytes
}

func cloneStrokeValues(strokes []map[string]any) []any {
	values := make([]any, len(strokes))
	for index, stroke := range strokes {
		values[index] = clonePayload(stroke)
	}
	return values
}

func (s *boardSnapshot) restorePayload(nowMillis float64) map[string]any {
	return map[string]any{
		"surface":    s.surface,
		"background": cloneOptionalPayload(s.background),
		"strokes":    s.currentStrokes(nowMillis),
		"pointer":    clonePayload(s.pointer),
	}
}

func jsonSize(value any) int {
	data, err := json.Marshal(value)
	if err != nil {
		return maxStateBytes + 1
	}
	return len(data)
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
