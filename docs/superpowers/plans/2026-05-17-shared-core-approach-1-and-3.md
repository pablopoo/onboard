# Shared Core For Approach 1 And 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Onboard so the drawing model, board state, canvas rendering, board UI, and viewer UI are shared by the Go local-server app and the hosted WebRTC P2P app.

**Architecture:** The browser app owns product behavior through small vanilla JavaScript modules. Runtime-specific code lives behind transport adapters: a WebSocket relay transport for Approach 1 and a WebRTC DataChannel transport for Approach 3. Go owns static serving, local relay mode, release binaries, and hosted signaling mode.

**Tech Stack:** Go, embedded static files, vanilla JavaScript modules, browser Canvas, WebSocket, WebRTC DataChannel, Node built-in test runner for pure JavaScript tests.

---

## Plan Review

Findings from the first draft:

1. **Task 7 was too broad.** Hosted signaling, browser signaling, WebRTC transport, and mode selection were grouped together. That is too much surface area for one implementer and creates avoidable review risk. This plan splits those into separate packets.
2. **Task 5 mixed server and browser transport work.** The local relay hub, WebSocket endpoint, and browser WebSocket transport now have separate ownership and review gates.
3. **Task 1 did not include this plan file.** The first execution packet now commits approach notes, the Go installer, tests, and this subagent execution plan together.
4. **Write sets were not explicit enough.** Each packet now names exact files or directories the implementer may edit. Workers must not touch unrelated files.
5. **The Go embed shape needed to be compiler-valid.** Web assets are embedded from `web/assets.go` inside package `onboard/web`; no package embeds files through parent paths.
6. **Verification was too shallow for networking and browser behavior.** The plan now includes relay integration expectations, viewer isolation checks, and a browser smoke packet.
7. **The first draft did not define enough behavioral contracts.** The plan now defines board state, pointer payloads, URL defaults, relay replay, and error handling before the packet list.

## Subagent Execution Rules

- Use a fresh implementer subagent for each packet.
- Do not ask implementers to read the whole plan. Give the selected packet plus the shared context below.
- Tell every implementer: "You are not alone in the codebase. Do not revert edits made by others. Stay inside your allowed write set."
- Treat packets P00 through P16 as serial by default. Do not run implementation packets in parallel unless a later controller explicitly proves two packets have disjoint write sets and no dependency.
- After each implementer returns, the controller verifies the diff and runs the packet's verification commands.
- Then run two reviews before continuing:
  - Spec compliance review: checks the packet requirements were met and no extra scope was added.
  - Code quality review: checks maintainability, correctness risks, and missing tests.
- Review issues go back to the same implementer packet for fixes, then the same review repeats.
- A packet is complete only after verification passes and both reviews approve.
- Packet commits are tentative until both reviews pass. If review fixes are needed, amend the same packet commit or squash the packet's follow-up fix before moving to the next packet.
- The controller may keep P00 unreviewed if it is documentation-only, but every app-code packet P01 through P16 must pass both reviews.

## Shared Context For Every Implementer

Project objective:

```text
Onboard is a compact local-network board app. One browser/device is the Board with controls. Another browser/device is the Viewer with only the drawing output. Users can share the Viewer tab in Google Meet while drawing from a tablet or phone.
```

Selected architecture:

```text
Approach 1: Go single-binary local LAN app.
Approach 3: Hosted app with WebRTC P2P drawing and hosted signaling.
Shared core: browser-side protocol, board state, canvas renderer, board app, and viewer app.
Approach-specific layer: transport adapters and Go server mode.
```

Transport contract:

```js
{
  async connect() {},
  send(event) {},
  onEvent(handler) {},
  close() {}
}
```

Event shape:

```js
{
  id: "evt_000001",
  type: "stroke:start",
  boardId: "default",
  at: 1710000000000,
  payload: {
    strokeId: "stroke_000001",
    color: "#f8fafc",
    width: 4,
    point: { x: 0.25, y: 0.5, pressure: 0.7 }
  }
}
```

Valid event types:

```text
board:set-surface
stroke:start
stroke:point
stroke:end
stroke:expire
board:clear
pointer:show
pointer:move
pointer:hide
```

Core rule:

```text
Board and Viewer code must use only the transport contract. They must not call WebSocket, signaling, or WebRTC APIs directly.
```

## Behavioral Contracts

Board state:

```text
Supported board surfaces are whiteboard, blackboard, greenboard, and blueboard.
Default board surface is whiteboard.
whiteboard and blueboard support marker tools.
blackboard and greenboard support chalk tools.
Coordinates are normalized into 0..1 before storage.
Pressure is normalized into 0..1 before storage.
Unknown event types leave state unchanged.
Duplicate stroke:start for an active stroke ID replaces the active stroke reference but does not crash.
stroke:point for an unknown stroke ID is ignored.
stroke:end for an unknown stroke ID is ignored.
stroke:expire removes or hides an ephemeral stroke by stroke ID.
board:clear removes all strokes, clears active strokes, and hides the pointer.
snapshotBoardState returns plain serializable data without Map instances.
```

Stroke payloads:

```text
stroke:start payload contains strokeId, tool, color, width, point.
tool is marker, chalk, or eraser.
marker is valid for whiteboard and blueboard.
chalk is valid for blackboard and greenboard.
eraser is valid for every board surface.
ephemeral is optional boolean.
expiresAt is required when ephemeral is true.
Existing strokes keep their own style when the board surface changes.
```

Pointer payloads:

```text
pointer:show payload contains point.
pointer:move payload contains point.
pointer:hide payload may be empty.
Pointer rendering is explicit only; the viewer must not infer pointer visibility from ordinary drawing movement.
```

Relay behavior for Approach 1:

```text
The Go relay stores accepted board events in memory.
A new WebSocket client receives the current event snapshot after connecting.
board:clear is stored as the new baseline and clears older replayed stroke events.
Malformed client messages are ignored and must not be broadcast.
The relay broadcasts accepted events to every connected subscriber, including viewers.
The relay may echo events back to the sending board; board code must tolerate duplicate event IDs.
```

Hosted signaling behavior for Approach 3:

```text
The signaling server carries session and WebRTC setup messages only.
It must not inspect or relay drawing events.
WebRTC DataChannel name is onboard-events.
The board role creates the DataChannel.
The viewer role waits for the DataChannel.
If WebRTC fails, the first implementation reports disconnected state; TURN fallback is infrastructure work outside this plan.
```

URL defaults:

```text
/board defaults to ?transport=relay.
/viewer defaults to ?transport=relay.
?transport=webrtc enables signaling and WebRTC mode.
WebRTC viewer sessions are joined by session ID in the URL.
WebSocket relay URL defaults to /ws/relay on the current origin.
Signaling URL defaults to /signal on the current origin.
```

Browser UI boundaries:

```text
Board may show controls.
Viewer must not show drawing controls.
Viewer may show minimal connection state only if it does not look like a drawing control.
Board controls include board surface, compatible pen type, eraser, clear all, pointer, and ephemeral write.
Viewer shows board background, strokes, eraser effects, active pointer, and unexpired ephemeral strokes only.
Canvas layout must fill the usable viewport and avoid page scrolling during drawing.
```

Verification commands used across packets:

```bash
bash tests/install-go-latest-test.sh
npm run test:js
/usr/local/go/bin/go test ./...
```

Use only the commands relevant to the packet. If `go` is not on `PATH`, use `/usr/local/go/bin/go`.

## Target File Structure

```text
cmd/onboard/main.go
go.mod
go.sum
internal/hub/hub.go
internal/hub/hub_test.go
internal/server/server.go
internal/server/server_test.go
internal/signaling/signaling.go
internal/signaling/signaling_test.go
package.json
scripts/build-release.sh
scripts/install-go-latest.sh
tests/build-release-test.sh
tests/install-go-latest-test.sh
web/assets.go
web/index.html
web/board.html
web/viewer.html
web/styles.css
web/core/protocol.js
web/core/protocol.test.mjs
web/core/board-state.js
web/core/board-state.test.mjs
web/core/canvas-renderer.js
web/core/canvas-renderer.test.mjs
web/board/board.js
web/viewer/viewer.js
web/transports/transport-contract.js
web/transports/transport-contract.test.mjs
web/transports/websocket-relay-transport.js
web/transports/websocket-relay-transport.test.mjs
web/transports/signaling-client.js
web/transports/signaling-client.test.mjs
web/transports/webrtc-datachannel-transport.js
web/transports/webrtc-datachannel-transport.test.mjs
```

## Dependency Graph

```text
P00 planning checkpoint
  -> P01 protocol
  -> P02 board state
  -> P03 canvas renderer
  -> P04 Go static server
  -> P05 browser transport contract
  -> P06 browser WebSocket transport
  -> P07 Go local relay hub and endpoint
  -> P08 board app for local relay
  -> P09 viewer app for local relay
  -> P10 local browser smoke checks
  -> P11 signaling registry
  -> P12 signaling endpoint
  -> P13 browser signaling client
  -> P14 WebRTC DataChannel transport
  -> P15 transport mode selection
  -> P16 documentation and release build
```

## Packet P00: Planning Checkpoint Commit

**Goal:** Commit current non-app planning work before implementation starts.

**Allowed Write Set:**

```text
docs/approaches/
docs/superpowers/plans/2026-05-17-shared-core-approach-1-and-3.md
scripts/install-go-latest.sh
tests/install-go-latest-test.sh
```

**Dependencies:** none.

- [ ] **Step 1: Verify installer test**

```bash
bash tests/install-go-latest-test.sh
```

Expected: exit code `0`.

- [ ] **Step 2: Verify no accidental placeholder markers in current docs and scripts**

```bash
rg -n "T""BD|TO""DO|FIX""ME|implement la""ter|fill i""n" docs scripts tests
```

Expected: exit code `1` with no matches.

- [ ] **Step 3: Commit planning artifacts**

```bash
git add docs/approaches docs/superpowers/plans scripts/install-go-latest.sh tests/install-go-latest-test.sh
git commit -m "docs: plan shared runtime approaches"
```

## Packet P01: Shared Event Protocol

**Goal:** Add the pure JavaScript board event protocol.

**Allowed Write Set:**

```text
package.json
web/core/protocol.js
web/core/protocol.test.mjs
```

**Dependencies:** P00.

- [ ] **Step 1: Write failing tests**

Create `package.json` with:

```json
{
  "name": "onboard",
  "private": true,
  "type": "module",
  "scripts": {
    "test:js": "node --test web/**/*.test.mjs"
  }
}
```

Create `web/core/protocol.test.mjs` with tests for:

```text
createBoardEvent creates a valid stroke:start event.
normalizePoint clamps x, y, and pressure into 0..1.
validateBoardEvent rejects an unknown event type.
validateBoardEvent accepts board:set-surface and stroke:expire.
validateBoardEvent accepts an ephemeral stroke:start with expiresAt.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because `web/core/protocol.js` is missing.

- [ ] **Step 3: Implement**

Create `web/core/protocol.js` exporting:

```text
createBoardEvent(type, payload = {}, boardId = "default")
normalizePoint(point)
validateBoardEvent(event)
isToolAllowedForSurface(tool, surface)
```

Implementation requirements:

```text
Event IDs use evt_000001 format.
Timestamps use Date.now().
Unknown event types return { valid: false, reason }.
Missing id, boardId, timestamp, or object payload returns { valid: false, reason }.
normalizePoint converts invalid numeric values to the lower bound.
isToolAllowedForSurface returns true for marker on whiteboard/blueboard, chalk on blackboard/greenboard, and eraser on every surface.
```

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json web/core/protocol.js web/core/protocol.test.mjs
git commit -m "feat: define shared board event protocol"
```

## Packet P02: Shared Board State

**Goal:** Add shared in-browser board state and event application.

**Allowed Write Set:**

```text
web/core/board-state.js
web/core/board-state.test.mjs
```

**Dependencies:** P01.

- [ ] **Step 1: Write failing tests**

Create `web/core/board-state.test.mjs` with tests for:

```text
default state uses whiteboard.
board:set-surface changes board surface.
stroke:start creates a stroke with style and first point.
stroke:point appends a point to the active stroke.
stroke:end marks the stroke complete.
stroke:expire removes or hides an ephemeral stroke.
board:clear removes strokes and hides pointer.
pointer:show, pointer:move, and pointer:hide update pointer state.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because `web/core/board-state.js` is missing.

- [ ] **Step 3: Implement**

Create `web/core/board-state.js` exporting:

```text
createBoardState()
applyBoardEvent(state, event)
snapshotBoardState(state)
```

State shape:

```js
{
  surface: "whiteboard",
  strokes: [],
  activeStrokes: new Map(),
  pointer: { visible: false, point: null }
}
```

Implementation requirements:

```text
Do not mutate event objects.
Store stroke points in normalized coordinate space.
snapshotBoardState returns plain serializable data, not a Map.
Unknown event types leave state unchanged.
Keep each stroke's tool, color, width, ephemeral, and expiresAt metadata.
```

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/core/board-state.js web/core/board-state.test.mjs
git commit -m "feat: add shared board state"
```

## Packet P03: Canvas Renderer

**Goal:** Add shared canvas rendering for board and viewer.

**Allowed Write Set:**

```text
web/core/canvas-renderer.js
web/core/canvas-renderer.test.mjs
```

**Dependencies:** P02.

- [ ] **Step 1: Write failing tests**

Create `web/core/canvas-renderer.test.mjs` with a fake 2D context that records calls. Test:

```text
renderBoardState clears the canvas.
renderBoardState draws a completed stroke using normalized points.
renderBoardState draws the pointer only when pointer.visible is true.
renderBoardState paints the active board surface background.
renderBoardState skips expired ephemeral strokes when given a current time.
resizeCanvasToDisplaySize uses devicePixelRatio and returns whether size changed.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because `web/core/canvas-renderer.js` is missing.

- [ ] **Step 3: Implement**

Create `web/core/canvas-renderer.js` exporting:

```text
renderBoardState(ctx, state, size)
resizeCanvasToDisplaySize(canvas, ratio = window.devicePixelRatio || 1)
```

Implementation requirements:

```text
Use normalized x/y multiplied by size width/height.
Draw strokes with round caps and joins.
Render marker and chalk differently enough that the board type feels intentional.
Render eraser strokes as removal masks or background-colored strokes.
Draw pointer as an explicit circle marker.
Do not know anything about Board or Viewer controls.
```

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/core/canvas-renderer.js web/core/canvas-renderer.test.mjs
git commit -m "feat: add shared canvas renderer"
```

## Packet P04: Go Static Server Skeleton

**Goal:** Add the Go binary entry point and embedded static web server.

**Allowed Write Set:**

```text
cmd/onboard/main.go
go.mod
internal/server/server.go
internal/server/server_test.go
web/assets.go
web/index.html
web/board.html
web/viewer.html
web/styles.css
```

**Dependencies:** P03.

- [ ] **Step 1: Write failing Go route test**

Create `internal/server/server_test.go` testing:

```text
GET / returns 200.
GET /board returns 200.
GET /viewer returns 200.
GET /health returns 200 with body ok.
```

- [ ] **Step 2: Add module**

Create `go.mod`:

```go
module onboard

go 1.26
```

- [ ] **Step 3: Verify red**

```bash
/usr/local/go/bin/go test ./...
```

Expected: fails because server constructor does not exist.

- [ ] **Step 4: Implement server package**

Create `internal/server/server.go` with:

```text
Config struct with Mode string, Addr string.
New(config Config) http.Handler.
/health route.
/board route serving board.html.
/viewer route serving viewer.html.
/ route serving static files.
```

Use `web/assets.go`:

```go
package web

import "embed"

//go:embed *
var Files embed.FS
```

- [ ] **Step 5: Implement main**

Create `cmd/onboard/main.go` with:

```text
Read optional ONBOARD_ADDR, default :0.
Start HTTP server.
Print Local, Board, and Viewer URLs.
Use internal/server.New(server.Config{Mode: "local"}).
```

- [ ] **Step 6: Add minimal pages**

Create:

```text
web/index.html with links to /board and /viewer.
web/board.html with #board-app, presenter controls, and a canvas.
web/viewer.html with #viewer-app and a canvas only.
web/styles.css with stable full-window canvas layout.
```

- [ ] **Step 7: Verify green**

```bash
/usr/local/go/bin/go test ./...
```

Expected: all Go tests pass.

- [ ] **Step 8: Commit**

```bash
git add cmd go.mod internal/server web/assets.go web/index.html web/board.html web/viewer.html web/styles.css
git commit -m "feat: add Go static server"
```

## Packet P05: Browser Transport Contract

**Goal:** Add testable transport contract validation used by relay and WebRTC transports.

**Allowed Write Set:**

```text
web/transports/transport-contract.js
web/transports/transport-contract.test.mjs
```

**Dependencies:** P04.

- [ ] **Step 1: Write failing tests**

Create tests proving:

```text
assertTransport accepts an object with connect, send, onEvent, close.
assertTransport throws TypeError with method name when a method is missing.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because contract module is missing.

- [ ] **Step 3: Implement**

Create `web/transports/transport-contract.js` exporting:

```text
assertTransport(transport)
```

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/transports/transport-contract.js web/transports/transport-contract.test.mjs
git commit -m "feat: define browser transport contract"
```

## Packet P06: Browser WebSocket Relay Transport

**Goal:** Add the browser transport for Approach 1 relay mode.

**Allowed Write Set:**

```text
web/transports/websocket-relay-transport.js
web/transports/websocket-relay-transport.test.mjs
```

**Dependencies:** P05.

- [ ] **Step 1: Write failing tests**

Use a fake WebSocket class in `web/transports/websocket-relay-transport.test.mjs`. Test:

```text
connect constructs WebSocket with the configured URL.
send serializes events with JSON.stringify.
message events parse JSON and call registered handlers.
close closes the socket.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because WebSocket relay transport is missing.

- [ ] **Step 3: Implement**

Create `web/transports/websocket-relay-transport.js` exporting:

```text
createWebSocketRelayTransport({ url, WebSocketImpl = WebSocket })
```

It must satisfy `assertTransport`.

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/transports/websocket-relay-transport.js web/transports/websocket-relay-transport.test.mjs
git commit -m "feat: add browser WebSocket relay transport"
```

## Packet P07: Go Local Relay Hub And Endpoint

**Goal:** Add Approach 1 server-side event relay and in-memory replay.

**Allowed Write Set:**

```text
go.mod
go.sum
internal/hub/hub.go
internal/hub/hub_test.go
internal/server/server.go
internal/server/server_test.go
```

**Dependencies:** P06.

- [ ] **Step 1: Write failing hub tests**

Create `internal/hub/hub_test.go` testing:

```text
Record appends an event.
Snapshot returns a copy.
Clear removes recorded events when board:clear is recorded.
Subscribe receives events recorded after subscription.
```

- [ ] **Step 2: Verify red**

```bash
/usr/local/go/bin/go test ./...
```

Expected: fails because hub package is missing.

- [ ] **Step 3: Implement hub**

Create `internal/hub/hub.go` with:

```text
Event struct matching the browser event JSON.
Hub struct with mutex-protected event slice and subscriber channels.
New()
Record(event Event)
Snapshot() []Event
Subscribe() (<-chan Event, func())
```

- [ ] **Step 4: Add WebSocket endpoint**

Use `github.com/coder/websocket` for `/ws/relay`.

Endpoint behavior:

```text
On connect, send current Snapshot events to the client.
When a client sends an event, Record it and broadcast to subscribers.
Do not send malformed JSON to subscribers.
```

- [ ] **Step 5: Verify green**

```bash
/usr/local/go/bin/go test ./...
```

Expected: all Go tests pass.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/hub internal/server
git commit -m "feat: add local relay hub"
```

## Packet P08: Board App For Local Relay

**Goal:** Add the Board browser app using shared core and the WebSocket transport.

**Allowed Write Set:**

```text
web/board/board.js
web/board.html
web/styles.css
```

**Dependencies:** P07.

- [ ] **Step 1: Implement Board UI**

Requirements:

```text
Board page has visible controls.
Board page has a canvas drawing surface.
Board controls include board surface, compatible pen type, eraser, clear all, pointer, and ephemeral write.
Changing board surface emits board:set-surface.
Pointer input emits stroke:start, stroke:point, stroke:end.
Ephemeral write emits strokes with ephemeral true and expiresAt.
Clear control emits board:clear.
Local state updates immediately before network echo.
Board app imports shared protocol, board state, renderer, and WebSocket relay transport.
```

- [ ] **Step 2: Verify**

```bash
npm run test:js
/usr/local/go/bin/go test ./...
```

Expected: all automated tests pass.

- [ ] **Step 3: Commit**

```bash
git add web/board/board.js web/board.html web/styles.css
git commit -m "feat: add board app for local relay"
```

## Packet P09: Viewer App For Local Relay

**Goal:** Add the Viewer browser app using shared core and the WebSocket transport.

**Allowed Write Set:**

```text
web/viewer/viewer.js
web/viewer.html
web/styles.css
```

**Dependencies:** P08.

- [ ] **Step 1: Implement Viewer UI**

Requirements:

```text
Viewer page has no drawing controls.
Viewer page has only the clean canvas output and minimal connection status if needed.
Viewer listens for relay events.
Viewer applies events through shared board state.
Viewer renders through shared canvas renderer.
Viewer reflects board surface changes, eraser effects, active pointer, and unexpired ephemeral strokes.
```

- [ ] **Step 2: Verify**

```bash
npm run test:js
/usr/local/go/bin/go test ./...
```

Expected: all automated tests pass.

- [ ] **Step 3: Commit**

```bash
git add web/viewer/viewer.js web/viewer.html web/styles.css
git commit -m "feat: add viewer app for local relay"
```

## Packet P10: Local Browser Smoke Checks

**Goal:** Verify Approach 1 works in real browser surfaces.

**Allowed Write Set:**

```text
tests/
docs/
```

**Dependencies:** P09.

- [ ] **Step 1: Start app**

```bash
/usr/local/go/bin/go run ./cmd/onboard
```

Expected output includes:

```text
Local:
Board:
Viewer:
```

- [ ] **Step 2: Browser smoke**

Use Playwright if available. Verify:

```text
/board loads without console errors.
/viewer loads without console errors.
Board has controls.
Viewer has no board controls.
Both pages have a canvas.
```

- [ ] **Step 3: Record findings**

If a repeatable smoke script is added, place it under `tests/`. If verification remains manual, add a concise checklist under `docs/`.

- [ ] **Step 4: Commit**

```bash
git add tests docs
git commit -m "test: add local browser smoke coverage"
```

## Packet P11: Signaling Registry

**Goal:** Add the pure Go in-memory session registry for Approach 3 signaling.

**Allowed Write Set:**

```text
internal/signaling/signaling.go
internal/signaling/signaling_test.go
```

**Dependencies:** P10.

- [ ] **Step 1: Write failing tests**

Create tests for:

```text
CreateSession returns a unique session ID.
JoinSession pairs a viewer with an existing session.
Subscribe returns messages for one peer only.
SendSignal routes offer, answer, and ice messages to the paired peer.
Unknown sessions return a typed error.
```

- [ ] **Step 2: Verify red**

```bash
/usr/local/go/bin/go test ./...
```

Expected: fails because signaling package is missing.

- [ ] **Step 3: Implement**

Create `internal/signaling/signaling.go`.

Requirements:

```text
Do not inspect drawing events.
Only route signaling messages.
Use mutex-protected maps.
Return copies of mutable data.
Expose small methods: CreateSession, JoinSession, Subscribe, SendSignal.
```

- [ ] **Step 4: Verify green**

```bash
/usr/local/go/bin/go test ./...
```

Expected: all Go tests pass.

- [ ] **Step 5: Commit**

```bash
git add internal/signaling
git commit -m "feat: add signaling registry"
```

## Packet P12: Signaling WebSocket Endpoint

**Goal:** Expose the signaling registry over a Go WebSocket endpoint.

**Allowed Write Set:**

```text
internal/server/server.go
internal/server/server_test.go
go.mod
go.sum
```

**Dependencies:** P11.

- [ ] **Step 1: Add failing endpoint tests**

Extend server tests to verify:

```text
/signal accepts WebSocket upgrade.
Malformed signaling messages close or reject cleanly.
Valid create/join/signal messages reach the signaling registry.
```

- [ ] **Step 2: Implement endpoint**

Add `/signal` to `internal/server/server.go` using the same WebSocket library as relay mode.

Message names:

```text
session:create
session:join
signal:offer
signal:answer
signal:ice
```

- [ ] **Step 3: Verify**

```bash
/usr/local/go/bin/go test ./...
```

Expected: all Go tests pass.

- [ ] **Step 4: Commit**

```bash
git add internal/server go.mod go.sum
git commit -m "feat: expose signaling endpoint"
```

## Packet P13: Browser Signaling Client

**Goal:** Add browser-side signaling client used by WebRTC transport.

**Allowed Write Set:**

```text
web/transports/signaling-client.js
web/transports/signaling-client.test.mjs
```

**Dependencies:** P12.

- [ ] **Step 1: Write failing tests**

Use a fake WebSocket class to test:

```text
connect opens /signal.
createSession sends session:create.
joinSession sends session:join with sessionId.
sendSignal serializes offer, answer, and ice payloads.
message events call registered handlers.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because signaling client is missing.

- [ ] **Step 3: Implement**

Create `web/transports/signaling-client.js` exporting:

```text
createSignalingClient({ url, WebSocketImpl = WebSocket })
```

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/transports/signaling-client.js web/transports/signaling-client.test.mjs
git commit -m "feat: add browser signaling client"
```

## Packet P14: WebRTC DataChannel Transport

**Goal:** Add Approach 3 browser transport behind the shared transport contract.

**Allowed Write Set:**

```text
web/transports/webrtc-datachannel-transport.js
web/transports/webrtc-datachannel-transport.test.mjs
```

**Dependencies:** P13.

- [ ] **Step 1: Write failing tests**

Use fake `RTCPeerConnection` and fake `RTCDataChannel` classes. Test:

```text
board role creates data channel.
viewer role waits for data channel.
send serializes board events.
incoming data channel messages parse events and notify handlers.
offer, answer, and ice messages flow through signaling client.
close closes peer connection and channel.
```

- [ ] **Step 2: Verify red**

```bash
npm run test:js
```

Expected: fails because WebRTC transport is missing.

- [ ] **Step 3: Implement**

Create `web/transports/webrtc-datachannel-transport.js` exporting:

```text
createWebRTCDataChannelTransport({
  signaling,
  role,
  sessionId,
  RTCPeerConnectionImpl = RTCPeerConnection
})
```

Requirements:

```text
Satisfy assertTransport.
Use one DataChannel named onboard-events.
Do not import board or viewer app code.
Do not know canvas details.
```

- [ ] **Step 4: Verify green**

```bash
npm run test:js
```

Expected: all JavaScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/transports/webrtc-datachannel-transport.js web/transports/webrtc-datachannel-transport.test.mjs
git commit -m "feat: add WebRTC data channel transport"
```

## Packet P15: Transport Mode Selection

**Goal:** Let Board and Viewer choose relay or WebRTC transport without changing shared app logic.

**Allowed Write Set:**

```text
web/board/board.js
web/viewer/viewer.js
web/index.html
web/board.html
web/viewer.html
```

**Dependencies:** P14.

- [ ] **Step 1: Implement mode selection**

Requirements:

```text
Default transport is relay.
?transport=relay uses WebSocket relay transport.
?transport=webrtc uses signaling client and WebRTC DataChannel transport.
Board creates sessions for WebRTC mode.
Viewer joins sessions for WebRTC mode.
Session ID can be supplied in URL.
Index page exposes links for local relay and hosted WebRTC flows.
```

- [ ] **Step 2: Verify**

```bash
npm run test:js
/usr/local/go/bin/go test ./...
```

Expected: all automated tests pass.

- [ ] **Step 3: Commit**

```bash
git add web/board/board.js web/viewer/viewer.js web/index.html web/board.html web/viewer.html
git commit -m "feat: add transport mode selection"
```

## Packet P16: Documentation And Release Builds

**Goal:** Document the selected dual-approach architecture and add cross-platform build script.

**Allowed Write Set:**

```text
README.md
docs/architecture.md
docs/roadmap.md
scripts/build-release.sh
tests/build-release-test.sh
```

**Dependencies:** P15.

- [ ] **Step 1: Add failing release script test**

Create `tests/build-release-test.sh` checking:

```text
scripts/build-release.sh exists.
scripts/build-release.sh is executable.
bash -n scripts/build-release.sh passes.
Script contains linux amd64 build.
Script contains windows amd64 build.
Script contains darwin amd64 build.
Script contains darwin arm64 build.
```

- [ ] **Step 2: Verify red**

```bash
bash tests/build-release-test.sh
```

Expected: fails because release script is missing.

- [ ] **Step 3: Implement release script**

Create executable `scripts/build-release.sh` that builds:

```text
dist/onboard-linux-amd64
dist/onboard-windows-amd64.exe
dist/onboard-macos-amd64
dist/onboard-macos-arm64
```

Use:

```text
CGO_ENABLED=0
/usr/local/go/bin/go build
```

- [ ] **Step 4: Update docs**

Update docs to state:

```text
Shared browser core is product logic.
Approach 1 uses Go local WebSocket relay.
Approach 3 uses Go hosted signaling plus WebRTC DataChannel.
End-user local binary is Approach 1.
No-install hosted pairing is Approach 3.
Presenter tools include board surface, compatible pen type, eraser, clear all, pointer, and ephemeral write.
Viewer shows content only and never presenter controls.
```

- [ ] **Step 5: Verify**

```bash
bash tests/build-release-test.sh
/usr/local/go/bin/go test ./...
npm run test:js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add README.md docs scripts/build-release.sh tests/build-release-test.sh
git commit -m "docs: document shared core architecture"
```

## Review Packets

Use these after every implementation packet.

### Spec Compliance Reviewer Prompt

```text
Review the last implementation packet for spec compliance only.

Packet: <paste packet text>
Changed files: <paste git diff --stat and relevant diff>

Check:
- All packet requirements are implemented.
- The worker stayed inside the allowed write set.
- No unrelated features were added.
- Required verification commands were run and passed.

Return:
- APPROVED, or
- CHANGES_REQUESTED with exact file/line references and required fixes.
```

### Code Quality Reviewer Prompt

```text
Review the last implementation packet for code quality only after spec compliance is approved.

Packet: <paste packet text>
Changed files: <paste git diff --stat and relevant diff>

Check:
- Correctness risks.
- Race conditions or state bugs.
- Missing edge case tests.
- Unnecessary abstraction.
- Browser/server boundary leaks.
- Maintainability.

Return:
- APPROVED, or
- CHANGES_REQUESTED with severity, exact file/line references, and required fixes.
```

## Final Acceptance

The full plan is complete only when:

```text
All packets P00 through P16 are committed.
bash tests/install-go-latest-test.sh passes.
bash tests/build-release-test.sh passes.
/usr/local/go/bin/go test ./... passes.
npm run test:js passes.
Approach 1 local Board and Viewer pass browser smoke checks.
Approach 3 signaling and WebRTC transport pass automated unit tests.
README explains local binary mode and hosted P2P mode.
```
