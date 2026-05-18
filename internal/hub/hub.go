package hub

import "sync"

const subscriberBufferSize = 64

type Event struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	BoardID string         `json:"boardId"`
	At      float64        `json:"at"`
	Payload map[string]any `json:"payload"`
}

type Hub struct {
	mu          sync.Mutex
	events      []Event
	subscribers map[*subscription]struct{}
}

type subscription struct {
	events    chan Event
	closeOnce sync.Once
}

func New() *Hub {
	return &Hub{
		subscribers: make(map[*subscription]struct{}),
	}
}

func (h *Hub) Record(event Event) {
	stored := cloneEvent(event)

	h.mu.Lock()

	if stored.Type == "board:clear" {
		h.events = replayBaselineAfterClear(h.events, stored)
	} else {
		h.events = append(h.events, cloneEvent(stored))
	}

	var dropped []*subscription
	for subscriber := range h.subscribers {
		select {
		case subscriber.events <- cloneEvent(stored):
		default:
			delete(h.subscribers, subscriber)
			dropped = append(dropped, subscriber)
		}
	}
	h.mu.Unlock()

	for _, subscriber := range dropped {
		subscriber.close()
	}
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
	subscriber := &subscription{
		events: make(chan Event, subscriberBufferSize),
	}

	h.mu.Lock()
	snapshot := cloneEvents(h.events)
	h.subscribers[subscriber] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subscribers, subscriber)
			h.mu.Unlock()
			subscriber.close()
		})
	}

	return snapshot, subscriber.events, unsubscribe
}

func (s *subscription) close() {
	s.closeOnce.Do(func() {
		close(s.events)
	})
}

func replayBaselineAfterClear(events []Event, clear Event) []Event {
	for index := len(events) - 1; index >= 0; index-- {
		if events[index].Type == "board:set-surface" {
			return []Event{cloneEvent(events[index]), cloneEvent(clear)}
		}
	}

	return []Event{cloneEvent(clear)}
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
	default:
		return typed
	}
}
