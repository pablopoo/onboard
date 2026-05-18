# Architecture Notes

This is the initial direction, not a final contract.

## Proposed Shape

Use a small local server that serves the board and viewer pages and owns live synchronization.

```text
Drawing device
  /board
  canvas + controls
  sends stroke events

Local server
  static pages
  WebSocket hub
  in-memory board state

Shared browser tab
  /viewer
  canvas only
  receives stroke events
```

## Project Tree

Target structure for the shared-core architecture:

```text
onboard/
  cmd/
    onboard/
      main.go

  internal/
    server/
      server.go
      server_test.go
    hub/
      hub.go
      hub_test.go
    signaling/
      signaling.go
      signaling_test.go

  web/
    assets.go
    index.html
    board.html
    viewer.html
    styles.css

    core/
      protocol.js
      protocol.test.mjs
      board-state.js
      board-state.test.mjs
      canvas-renderer.js
      canvas-renderer.test.mjs

    board/
      board.js

    viewer/
      viewer.js

    transports/
      transport-contract.js
      transport-contract.test.mjs
      websocket-relay-transport.js
      websocket-relay-transport.test.mjs
      signaling-client.js
      signaling-client.test.mjs
      webrtc-datachannel-transport.js
      webrtc-datachannel-transport.test.mjs

  scripts/
    install-go-latest.sh
    build-release.sh

  tests/
    install-go-latest-test.sh
    build-release-test.sh
    browser-smoke.md or browser-smoke.sh

  docs/
    architecture.md
    roadmap.md
    project-objective.md
    approaches/
    superpowers/
      plans/

  package.json
  go.mod
  go.sum
  AGENTS.md
  README.md
```

Directory responsibilities:

- `cmd/onboard`: executable entrypoint.
- `internal/server`: HTTP routes, static serving, and mode wiring.
- `internal/hub`: Approach 1 local relay state and broadcast.
- `internal/signaling`: Approach 3 pairing and WebRTC signaling only.
- `web/core`: shared browser-side product logic.
- `web/transports`: event movement adapters.
- `web/board`: Board UI controller.
- `web/viewer`: Viewer UI controller.
- `web/assets.go`: embeds the static web app into the Go binary.
- `scripts`: local development and release tooling.
- `tests`: shell, release, and smoke checks.

## Routes

- `/board`: presenter surface with drawing tools.
- `/viewer`: clean output surface for screen sharing.
- `/health`: simple readiness endpoint if useful.

## Sync Model

Start with stroke events instead of video streaming or bitmap streaming.

Why:

- Smaller payloads.
- Easy to replay for new viewers.
- Easier to support undo later.
- Keeps implementation inspectable.

Initial event types can be:

- `board:set-surface`
- `stroke:start`
- `stroke:point`
- `stroke:end`
- `stroke:expire`
- `board:clear`
- `pointer:show`
- `pointer:move`
- `pointer:hide`

## Board Surfaces And Tools

Supported board surfaces:

```text
whiteboard -> marker tools
blackboard -> chalk tools
greenboard -> chalk tools
blueboard -> marker tools
```

Stroke payloads should carry their rendering style so old strokes remain visually stable after the presenter changes tools:

```text
tool: marker | chalk | eraser
color: CSS color
width: number
ephemeral: boolean
expiresAt: timestamp, only for ephemeral strokes
```

The eraser is modeled as a drawing tool in the event stream, not as a viewer control. Clear all is modeled as `board:clear`.

The pointer is separate from drawing. Pointer events update explicit pointer state and must not create strokes.

## Visual Assets

Image generation is allowed when it helps the app feel like a real board without adding unnecessary implementation complexity.

Good uses:

- Subtle whiteboard, blackboard, greenboard, or blueboard surface texture references.
- Icon references for presenter controls.
- Visual references for chalk versus marker treatment.
- Lightweight bitmap assets if CSS/canvas alone is not enough.

Constraints:

- Generated assets must not replace the core canvas drawing model.
- Generated assets must not be required for sync correctness.
- Keep assets small and inspectable.
- Prefer CSS/canvas rendering when it is sufficient.

## State

Initial state should be in memory.

That means:

- Restarting the server clears the board.
- A newly connected viewer receives current in-memory strokes.
- Persistence is deferred until there is a real need.

## First Stack Preference

The first implementation should prefer the smallest stack that handles:

- HTTP static serving.
- WebSocket connections.
- Simple browser JavaScript.

A likely candidate is Node.js with a minimal server and the `ws` package, but that decision belongs to Phase 02.

## Risks To Watch

- Touch drawing can accidentally scroll the page.
- Canvas sizes must match cleanly between board and viewer.
- Different device pixel ratios can make strokes blurry or offset.
- WebSocket reconnects need simple behavior before real use.
- Viewer must never show board controls.
