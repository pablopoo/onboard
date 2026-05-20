# Architecture Notes

Onboard uses one shared browser core with two runtime approaches.

The shared browser core is product logic. It owns the event protocol, board
state, canvas rendering rules, surface/tool compatibility, pointer state, and
ephemeral stroke behavior. Runtime transports only move events between Board and
Viewer.

## Selected Approaches

Approach 1 is the end-user local binary.

```text
Board browser
  /board
  canvas + presenter controls
  sends board events over WebSocket

Go local binary
  serves embedded web files
  owns /ws/relay
  keeps in-memory event state
  broadcasts events to connected browsers

Viewer browser
  /viewer
  canvas only
  receives board events over WebSocket
```

Approach 3 is the no-install hosted pairing path.

```text
Board browser
  /board?transport=webrtc
  creates or joins a paired session
  sends board events over WebRTC DataChannel

Go hosted signaling server
  serves the same web app
  owns /signal
  exchanges session, offer, answer, and ICE messages
  does not carry drawing events after DataChannel setup succeeds

Viewer browser
  /viewer?transport=webrtc
  canvas only
  receives board events over WebRTC DataChannel
```

Both approaches use the same `web/core` product logic. The difference is only
the transport adapter under `web/transports`.

## Project Tree

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
      clipboard.js
      clipboard.test.mjs
      qr.js
      qr.test.mjs

    board/
      board.js
      board.test.mjs

    home/
      home.js
      home.test.mjs

    viewer/
      viewer.js
      viewer.test.mjs

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
    local-browser-smoke.sh

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
- `internal/server`: HTTP routes, static serving, WebSocket relay endpoint, and
  signaling endpoint.
- `internal/hub`: Approach 1 local relay state and broadcast.
- `internal/signaling`: Approach 3 session pairing and WebRTC signaling.
- `web/core`: shared browser-side product logic.
- `web/home`: home-page share-link, copy, and QR behavior.
- `web/transports`: event movement adapters.
- `web/board`: Board presenter controller.
- `web/viewer`: Viewer content-only controller.
- `web/assets.go`: embeds the static web app into the Go binary.
- `scripts`: local development and release tooling.
- `tests`: shell, release, and smoke checks.

## Routes

- `/`: home page with relay and WebRTC links.
- `/board`: presenter surface using the local WebSocket relay.
- `/viewer`: content-only viewer using the local WebSocket relay.
- `/board?transport=webrtc`: presenter surface using WebRTC DataChannel.
- `/viewer?transport=webrtc`: content-only viewer using WebRTC DataChannel.
- `/ws/relay`: Approach 1 WebSocket event relay.
- `/signal`: Approach 3 WebSocket signaling endpoint.
- `/health`: readiness endpoint.

## Event Model

Onboard syncs drawing events instead of video or bitmap frames.

Why:

- Smaller payloads.
- Easy replay for new viewers.
- Inspectable state transitions.
- Same event stream can move over WebSocket or WebRTC DataChannel.

Core event types:

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
blueboard  -> marker tools
blackboard -> chalk tools
greenboard -> chalk tools
```

Presenter tools include board surface, compatible pen type, eraser, clear all,
pointer, and ephemeral write.

Stroke payloads carry rendering style so existing strokes remain visually stable
after the presenter changes tools:

```text
tool: marker | chalk | eraser
color: CSS color
width: number
ephemeral: boolean
expiresAt: timestamp, only for ephemeral strokes
```

The eraser is modeled as a drawing tool in the event stream, not as a viewer
control. Clear all is modeled as `board:clear`. The pointer is separate from
drawing and must not create strokes.

## Presenter Controls

The Board uses a floating left toolbar on desktop and tablet-sized viewports.
The active tool highlight is neutral charcoal, never the active surface color,
so green/blue/black/white remain board-surface signals only.

On phone-sized viewports, the Board starts with a compact bottom dock. The dock
shows the active drawing mode, current surface color, current ink color when
drawing, fade state, and quick undo. Expanding it opens the full presenter
toolbar as a bottom sheet with an explicit minimize control. Compact tool
choices and drawing input collapse the toolbar again so the writing surface
stays clear.

Mobile controls should keep touch targets at roughly 44 CSS pixels or larger.
Detailed settings like tip size, eraser size, share link, and destructive clear
belong in the expanded toolbar rather than the compact dock.

## Viewer Contract

The Viewer is content-only. It shows:

- Board background.
- Strokes.
- Eraser effects.
- Explicit pointer only when the presenter uses pointer mode.
- Unexpired ephemeral strokes.

The Viewer never shows presenter controls.

## State

Approach 1 keeps state in memory in the local Go process.

- Restarting the server clears the board.
- A newly connected relay viewer receives current in-memory events.
- Persistence is deferred until there is a real need.

Approach 3 uses the same browser state model after pairing. The signaling server
exists to pair browsers and exchange WebRTC setup messages; the DataChannel
carries drawing events.

## Release Builds

Release binaries are cross-compiled with `CGO_ENABLED=0` using
`/usr/local/go/bin/go build`.

```text
dist/onboard-linux-amd64
dist/onboard-windows-amd64.exe
dist/onboard-macos-amd64
dist/onboard-macos-arm64
```

The build script is `scripts/build-release.sh`; its shell check is
`tests/build-release-test.sh`.

## Risks To Watch

- Touch drawing can accidentally scroll the page.
- Canvas sizes must match cleanly between board and viewer.
- Different device pixel ratios can make strokes blurry or offset.
- Reconnect behavior must remain simple and visible when a browser, socket, or
  data channel drops.
- WebRTC signaling errors must fail fast instead of leaving pairing or reconnect
  flows waiting forever.
- Viewer must never show board controls.
