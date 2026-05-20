package signaling

import (
	"errors"
	"strconv"
	"sync"
)

const subscriberBufferSize = 64

var (
	ErrUnknownSession    = errors.New("signaling: unknown session")
	ErrUnknownPeer       = errors.New("signaling: unknown peer")
	ErrPeerAlreadyJoined = errors.New("signaling: peer already joined")
	ErrPeerNotJoined     = errors.New("signaling: peer not joined")
	ErrUnknownSignalType = errors.New("signaling: unknown signal type")
)

type Role string

const (
	RoleBoard  Role = "board"
	RoleViewer Role = "viewer"
)

type SignalType string

const (
	SignalOffer    SignalType = "offer"
	SignalAnswer   SignalType = "answer"
	SignalICE      SignalType = "ice"
	SignalPeerLeft SignalType = "peer-left"
)

type Peer struct {
	ID   string
	Role Role
}

type Session struct {
	ID     string
	Board  Peer
	Viewer Peer
}

type Signal struct {
	Type       SignalType     `json:"type"`
	FromPeerID string         `json:"-"`
	Payload    map[string]any `json:"payload,omitempty"`
}

type Registry struct {
	mu       sync.Mutex
	nextID   uint64
	sessions map[string]*session
}

type session struct {
	id          string
	board       Peer
	viewer      Peer
	subscribers map[string]map[*subscription]struct{}
}

type subscription struct {
	signals   chan Signal
	closeOnce sync.Once
}

func NewRegistry() *Registry {
	return &Registry{
		sessions: make(map[string]*session),
	}
}

func (r *Registry) CreateSession(boardPeerID string) Session {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.nextID++
	sessionID := "session-" + strconv.FormatUint(r.nextID, 36)
	session := &session{
		id: sessionID,
		board: Peer{
			ID:   boardPeerID,
			Role: RoleBoard,
		},
		viewer: Peer{
			Role: RoleViewer,
		},
		subscribers: make(map[string]map[*subscription]struct{}),
	}
	r.sessions[sessionID] = session

	return session.snapshot()
}

// JoinSession pairs the first viewer with a board-created session. Later viewer
// joins are rejected instead of replacing the active pair.
func (r *Registry) JoinSession(sessionID string, viewerPeerID string) (Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	session, ok := r.sessions[sessionID]
	if !ok {
		return Session{}, ErrUnknownSession
	}
	if session.viewer.ID != "" {
		return Session{}, ErrPeerAlreadyJoined
	}

	session.viewer.ID = viewerPeerID
	session.viewer.Role = RoleViewer

	return session.snapshot(), nil
}

func (r *Registry) ReleasePeer(sessionID string, peerID string) error {
	r.mu.Lock()
	session, ok := r.sessions[sessionID]
	if !ok {
		r.mu.Unlock()
		return ErrUnknownSession
	}

	var closing []*subscription
	switch {
	case session.board.ID == peerID:
		for _, subscriptions := range session.subscribers {
			for subscriber := range subscriptions {
				closing = append(closing, subscriber)
			}
		}
		delete(r.sessions, sessionID)

	case session.viewer.ID == peerID:
		r.sendSignalLocked(session.subscribers[session.board.ID], Signal{
			Type:       SignalPeerLeft,
			FromPeerID: peerID,
			Payload: map[string]any{
				"role": string(RoleViewer),
			},
		}, &closing)
		for subscriber := range session.subscribers[peerID] {
			closing = append(closing, subscriber)
		}
		delete(session.subscribers, peerID)
		session.viewer = Peer{Role: RoleViewer}

	default:
		r.mu.Unlock()
		return ErrUnknownPeer
	}
	r.mu.Unlock()

	for _, subscriber := range closing {
		subscriber.close()
	}

	return nil
}

func (r *Registry) Subscribe(sessionID string, peerID string) (<-chan Signal, func(), error) {
	subscriber := &subscription{
		signals: make(chan Signal, subscriberBufferSize),
	}

	r.mu.Lock()
	session, ok := r.sessions[sessionID]
	if !ok {
		r.mu.Unlock()
		subscriber.close()
		return nil, nil, ErrUnknownSession
	}
	if !session.hasPeer(peerID) {
		r.mu.Unlock()
		subscriber.close()
		return nil, nil, ErrUnknownPeer
	}

	if session.subscribers[peerID] == nil {
		session.subscribers[peerID] = make(map[*subscription]struct{})
	}
	session.subscribers[peerID][subscriber] = struct{}{}
	r.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			r.mu.Lock()
			if session, ok := r.sessions[sessionID]; ok {
				delete(session.subscribers[peerID], subscriber)
				if len(session.subscribers[peerID]) == 0 {
					delete(session.subscribers, peerID)
				}
			}
			r.mu.Unlock()
			subscriber.close()
		})
	}

	return subscriber.signals, unsubscribe, nil
}

func (r *Registry) SendSignal(sessionID string, fromPeerID string, signal Signal) error {
	r.mu.Lock()
	session, ok := r.sessions[sessionID]
	if !ok {
		r.mu.Unlock()
		return ErrUnknownSession
	}
	if !isWebRTCSignal(signal.Type) {
		r.mu.Unlock()
		return ErrUnknownSignalType
	}

	toPeerID, err := session.pairedPeerID(fromPeerID)
	if err != nil {
		r.mu.Unlock()
		return err
	}

	outbound := cloneSignal(signal)
	outbound.FromPeerID = fromPeerID
	var dropped []*subscription
	r.sendSignalLocked(session.subscribers[toPeerID], outbound, &dropped)
	if len(session.subscribers[toPeerID]) == 0 {
		delete(session.subscribers, toPeerID)
	}
	r.mu.Unlock()

	for _, subscriber := range dropped {
		subscriber.close()
	}

	return nil
}

func (r *Registry) sendSignalLocked(subscribers map[*subscription]struct{}, signal Signal, dropped *[]*subscription) {
	for subscriber := range subscribers {
		select {
		case subscriber.signals <- cloneSignal(signal):
		default:
			delete(subscribers, subscriber)
			*dropped = append(*dropped, subscriber)
		}
	}
}

func (s *session) snapshot() Session {
	return Session{
		ID:     s.id,
		Board:  s.board,
		Viewer: s.viewer,
	}
}

func (s *session) hasPeer(peerID string) bool {
	if s.board.ID == peerID {
		return true
	}
	return s.viewer.ID != "" && s.viewer.ID == peerID
}

func (s *session) pairedPeerID(fromPeerID string) (string, error) {
	switch {
	case s.board.ID == fromPeerID:
		if s.viewer.ID == "" {
			return "", ErrPeerNotJoined
		}
		return s.viewer.ID, nil
	case s.viewer.ID != "" && s.viewer.ID == fromPeerID:
		return s.board.ID, nil
	default:
		return "", ErrUnknownPeer
	}
}

func (s *subscription) close() {
	s.closeOnce.Do(func() {
		close(s.signals)
	})
}

func isWebRTCSignal(signalType SignalType) bool {
	switch signalType {
	case SignalOffer, SignalAnswer, SignalICE:
		return true
	default:
		return false
	}
}

func cloneSignal(signal Signal) Signal {
	return Signal{
		Type:       signal.Type,
		FromPeerID: signal.FromPeerID,
		Payload:    clonePayload(signal.Payload),
	}
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
