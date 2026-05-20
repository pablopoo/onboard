package signaling_test

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"onboard/internal/signaling"
)

func TestCreateSessionReturnsUniqueSessionID(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()

	first := registry.CreateSession("board-1")
	second := registry.CreateSession("board-2")

	if first.ID == "" {
		t.Fatal("first session ID is empty")
	}
	if second.ID == "" {
		t.Fatal("second session ID is empty")
	}
	if first.ID == second.ID {
		t.Fatalf("session IDs are both %q, want unique IDs", first.ID)
	}
	if first.Board.ID != "board-1" {
		t.Fatalf("first board peer ID = %q, want board-1", first.Board.ID)
	}
	if first.Board.Role != signaling.RoleBoard {
		t.Fatalf("first board role = %q, want %q", first.Board.Role, signaling.RoleBoard)
	}
	if first.Viewer.ID != "" {
		t.Fatalf("first viewer peer ID = %q, want empty before join", first.Viewer.ID)
	}
	if first.Viewer.Role != signaling.RoleViewer {
		t.Fatalf("first viewer role = %q, want %q", first.Viewer.Role, signaling.RoleViewer)
	}
}

func TestJoinSessionPairsViewerWithExistingSession(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	created := registry.CreateSession("board-1")

	joined, err := registry.JoinSession(created.ID, "viewer-1")
	if err != nil {
		t.Fatalf("JoinSession returned error: %v", err)
	}

	if joined.ID != created.ID {
		t.Fatalf("joined session ID = %q, want %q", joined.ID, created.ID)
	}
	if joined.Board.ID != "board-1" {
		t.Fatalf("joined board peer ID = %q, want board-1", joined.Board.ID)
	}
	if joined.Viewer.ID != "viewer-1" {
		t.Fatalf("joined viewer peer ID = %q, want viewer-1", joined.Viewer.ID)
	}
	if joined.Board.Role != signaling.RoleBoard {
		t.Fatalf("joined board role = %q, want %q", joined.Board.Role, signaling.RoleBoard)
	}
	if joined.Viewer.Role != signaling.RoleViewer {
		t.Fatalf("joined viewer role = %q, want %q", joined.Viewer.Role, signaling.RoleViewer)
	}
}

func TestJoinSessionRejectsUnknownSessionWithTypedError(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()

	_, err := registry.JoinSession("missing-session", "viewer-1")

	if !errors.Is(err, signaling.ErrUnknownSession) {
		t.Fatalf("JoinSession error = %v, want ErrUnknownSession", err)
	}
}

func TestJoinSessionRejectsDuplicateViewer(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	created := registry.CreateSession("board-1")
	if _, err := registry.JoinSession(created.ID, "viewer-1"); err != nil {
		t.Fatalf("first JoinSession returned error: %v", err)
	}

	_, err := registry.JoinSession(created.ID, "viewer-2")

	if !errors.Is(err, signaling.ErrPeerAlreadyJoined) {
		t.Fatalf("second JoinSession error = %v, want ErrPeerAlreadyJoined", err)
	}
}

func TestReleaseViewerAllowsAnotherViewerToJoin(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	created := registry.CreateSession("board-1")
	if _, err := registry.JoinSession(created.ID, "viewer-1"); err != nil {
		t.Fatalf("first JoinSession returned error: %v", err)
	}

	if err := registry.ReleasePeer(created.ID, "viewer-1"); err != nil {
		t.Fatalf("ReleasePeer returned error: %v", err)
	}

	joined, err := registry.JoinSession(created.ID, "viewer-2")
	if err != nil {
		t.Fatalf("second JoinSession returned error: %v", err)
	}
	if joined.Viewer.ID != "viewer-2" {
		t.Fatalf("joined viewer = %q, want viewer-2", joined.Viewer.ID)
	}
}

func TestReleaseViewerNotifiesBoardSubscriber(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	session := createPairedSession(t, registry)
	boardMessages, unsubscribeBoard, err := registry.Subscribe(session.ID, "board-1")
	if err != nil {
		t.Fatalf("Subscribe board returned error: %v", err)
	}
	defer unsubscribeBoard()

	if err := registry.ReleasePeer(session.ID, "viewer-1"); err != nil {
		t.Fatalf("ReleasePeer returned error: %v", err)
	}

	got := receiveSignal(t, boardMessages)
	if got.Type != signaling.SignalPeerLeft {
		t.Fatalf("peer-left signal type = %q, want %q", got.Type, signaling.SignalPeerLeft)
	}
	if got.FromPeerID != "viewer-1" {
		t.Fatalf("peer-left FromPeerID = %q, want viewer-1", got.FromPeerID)
	}
	if got.Payload["role"] != string(signaling.RoleViewer) {
		t.Fatalf("peer-left role = %v, want %q", got.Payload["role"], signaling.RoleViewer)
	}
}

func TestReleaseBoardDeletesSession(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	created := registry.CreateSession("board-1")
	if _, err := registry.JoinSession(created.ID, "viewer-1"); err != nil {
		t.Fatalf("JoinSession returned error: %v", err)
	}

	if err := registry.ReleasePeer(created.ID, "board-1"); err != nil {
		t.Fatalf("ReleasePeer returned error: %v", err)
	}

	_, err := registry.JoinSession(created.ID, "viewer-2")
	if !errors.Is(err, signaling.ErrUnknownSession) {
		t.Fatalf("JoinSession after board release error = %v, want ErrUnknownSession", err)
	}
}

func TestSubscribeReturnsMessagesForOnePeerOnly(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	session := createPairedSession(t, registry)
	boardMessages, unsubscribeBoard, err := registry.Subscribe(session.ID, "board-1")
	if err != nil {
		t.Fatalf("Subscribe board returned error: %v", err)
	}
	defer unsubscribeBoard()
	viewerMessages, unsubscribeViewer, err := registry.Subscribe(session.ID, "viewer-1")
	if err != nil {
		t.Fatalf("Subscribe viewer returned error: %v", err)
	}
	defer unsubscribeViewer()

	offer := testSignal(signaling.SignalOffer)
	if err := registry.SendSignal(session.ID, "board-1", offer); err != nil {
		t.Fatalf("SendSignal returned error: %v", err)
	}

	got := receiveSignal(t, viewerMessages)
	want := offer
	want.FromPeerID = "board-1"
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("viewer signal = %#v, want %#v", got, want)
	}
	assertNoSignal(t, boardMessages)
}

func TestSendSignalRoutesOfferAnswerAndIceToPairedPeer(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	session := createPairedSession(t, registry)
	boardMessages, unsubscribeBoard, err := registry.Subscribe(session.ID, "board-1")
	if err != nil {
		t.Fatalf("Subscribe board returned error: %v", err)
	}
	defer unsubscribeBoard()
	viewerMessages, unsubscribeViewer, err := registry.Subscribe(session.ID, "viewer-1")
	if err != nil {
		t.Fatalf("Subscribe viewer returned error: %v", err)
	}
	defer unsubscribeViewer()

	offer := testSignal(signaling.SignalOffer)
	answer := testSignal(signaling.SignalAnswer)
	ice := testSignal(signaling.SignalICE)

	if err := registry.SendSignal(session.ID, "board-1", offer); err != nil {
		t.Fatalf("SendSignal offer returned error: %v", err)
	}
	if err := registry.SendSignal(session.ID, "viewer-1", answer); err != nil {
		t.Fatalf("SendSignal answer returned error: %v", err)
	}
	if err := registry.SendSignal(session.ID, "viewer-1", ice); err != nil {
		t.Fatalf("SendSignal ice returned error: %v", err)
	}

	wantOffer := offer
	wantOffer.FromPeerID = "board-1"
	if got := receiveSignal(t, viewerMessages); !reflect.DeepEqual(got, wantOffer) {
		t.Fatalf("viewer offer = %#v, want %#v", got, wantOffer)
	}
	wantAnswer := answer
	wantAnswer.FromPeerID = "viewer-1"
	if got := receiveSignal(t, boardMessages); !reflect.DeepEqual(got, wantAnswer) {
		t.Fatalf("board answer = %#v, want %#v", got, wantAnswer)
	}
	wantICE := ice
	wantICE.FromPeerID = "viewer-1"
	if got := receiveSignal(t, boardMessages); !reflect.DeepEqual(got, wantICE) {
		t.Fatalf("board ice = %#v, want %#v", got, wantICE)
	}
}

func TestSendSignalRejectsUnknownSessionWithTypedError(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()

	err := registry.SendSignal("missing-session", "board-1", testSignal(signaling.SignalOffer))

	if !errors.Is(err, signaling.ErrUnknownSession) {
		t.Fatalf("SendSignal error = %v, want ErrUnknownSession", err)
	}
}

func TestSubscribeRejectsUnknownSessionWithTypedError(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()

	_, _, err := registry.Subscribe("missing-session", "board-1")

	if !errors.Is(err, signaling.ErrUnknownSession) {
		t.Fatalf("Subscribe error = %v, want ErrUnknownSession", err)
	}
}

func TestSendSignalRejectsUnknownPeerWithTypedError(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	session := createPairedSession(t, registry)

	err := registry.SendSignal(session.ID, "unknown-peer", testSignal(signaling.SignalOffer))

	if !errors.Is(err, signaling.ErrUnknownPeer) {
		t.Fatalf("SendSignal error = %v, want ErrUnknownPeer", err)
	}
}

func TestSendSignalRejectsNonWebRTCSignalType(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	session := createPairedSession(t, registry)
	viewerMessages, unsubscribeViewer, err := registry.Subscribe(session.ID, "viewer-1")
	if err != nil {
		t.Fatalf("Subscribe viewer returned error: %v", err)
	}
	defer unsubscribeViewer()

	err = registry.SendSignal(session.ID, "board-1", signaling.Signal{
		Type:    signaling.SignalType("stroke:start"),
		Payload: map[string]any{"strokeId": "stroke-1"},
	})

	if !errors.Is(err, signaling.ErrUnknownSignalType) {
		t.Fatalf("SendSignal error = %v, want ErrUnknownSignalType", err)
	}
	assertNoSignal(t, viewerMessages)
}

func TestSignalsAreCopiedBeforeDelivery(t *testing.T) {
	t.Parallel()

	registry := signaling.NewRegistry()
	session := createPairedSession(t, registry)
	viewerMessages, unsubscribeViewer, err := registry.Subscribe(session.ID, "viewer-1")
	if err != nil {
		t.Fatalf("Subscribe viewer returned error: %v", err)
	}
	defer unsubscribeViewer()
	secondViewerMessages, unsubscribeSecondViewer, err := registry.Subscribe(session.ID, "viewer-1")
	if err != nil {
		t.Fatalf("Subscribe second viewer returned error: %v", err)
	}
	defer unsubscribeSecondViewer()

	sent := signaling.Signal{
		Type: signaling.SignalOffer,
		Payload: map[string]any{
			"sdp": "initial",
			"candidate": map[string]any{
				"id": "candidate-1",
			},
			"numbers": []any{1.0, map[string]any{"n": 2.0}},
		},
	}
	if err := registry.SendSignal(session.ID, "board-1", sent); err != nil {
		t.Fatalf("SendSignal returned error: %v", err)
	}
	sent.Payload["sdp"] = "mutated"
	sent.Payload["candidate"].(map[string]any)["id"] = "mutated"
	sent.Payload["numbers"].([]any)[1].(map[string]any)["n"] = 3.0

	got := receiveSignal(t, viewerMessages)
	second := receiveSignal(t, secondViewerMessages)

	if got.Payload["sdp"] != "initial" {
		t.Fatalf("delivered sdp = %v, want initial", got.Payload["sdp"])
	}
	candidate := got.Payload["candidate"].(map[string]any)
	if candidate["id"] != "candidate-1" {
		t.Fatalf("delivered candidate ID = %v, want candidate-1", candidate["id"])
	}
	numbers := got.Payload["numbers"].([]any)
	nestedNumber := numbers[1].(map[string]any)["n"]
	if nestedNumber != 2.0 {
		t.Fatalf("delivered nested number = %v, want 2", nestedNumber)
	}

	got.Payload["sdp"] = "changed-after-receive"
	got.Payload["candidate"].(map[string]any)["id"] = "changed-after-receive"

	if second.Payload["sdp"] == "changed-after-receive" {
		t.Fatal("mutating one delivered signal affected another delivery")
	}
	secondCandidate := second.Payload["candidate"].(map[string]any)
	if secondCandidate["id"] == "changed-after-receive" {
		t.Fatal("mutating one delivered nested payload affected another delivery")
	}
}

func createPairedSession(t *testing.T, registry *signaling.Registry) signaling.Session {
	t.Helper()

	created := registry.CreateSession("board-1")
	joined, err := registry.JoinSession(created.ID, "viewer-1")
	if err != nil {
		t.Fatalf("JoinSession returned error: %v", err)
	}
	return joined
}

func testSignal(signalType signaling.SignalType) signaling.Signal {
	return signaling.Signal{
		Type: signalType,
		Payload: map[string]any{
			"sdp":       "payload-" + string(signalType),
			"candidate": "candidate-" + string(signalType),
		},
	}
}

func receiveSignal(t *testing.T, messages <-chan signaling.Signal) signaling.Signal {
	t.Helper()

	select {
	case got := <-messages:
		return got
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for signal")
	}
	return signaling.Signal{}
}

func assertNoSignal(t *testing.T, messages <-chan signaling.Signal) {
	t.Helper()

	select {
	case got := <-messages:
		t.Fatalf("received unexpected signal: %#v", got)
	case <-time.After(20 * time.Millisecond):
	}
}
