# Architecture Notes

Onboard has one supported release path: a small Go local-network web app.

The Go binary serves the browser app, owns the local WebSocket relay, and keeps
board state in memory. The browser app owns product behavior: event protocol,
board state, canvas rendering rules, surface/tool compatibility, pointer state,
and ephemeral stroke behavior.

## Runtime Shape

```text
Board browser
  /board
  canvas + presenter controls
  sends board events over WebSocket

Go local binary
  serves embedded web files
  owns /ws/relay
  keeps in-memory event state
  broadcasts events to connected viewers

Viewer browser
  /viewer
  canvas only
  receives board events over WebSocket
```

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

  web/
    assets.go
    index.html
    board.html
    viewer.html
    styles.css
    manifest.webmanifest
    board.webmanifest
    viewer.webmanifest
    icons/

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

  scripts/
    install-go-latest.sh
    build-release.sh

  tests/
    install-go-latest-test.sh
    build-release-test.sh
    local-browser-smoke.sh

  docs/
    architecture.md
    go-single-binary.md
    release.md
    roadmap.md
    project-objective.md

  package.json
  go.mod
  go.sum
  AGENTS.md
  README.md
```

Directory responsibilities:

- `cmd/onboard`: executable entrypoint and startup URL printing.
- `internal/server`: HTTP routes, static serving, share metadata, and the
  WebSocket relay endpoint.
- `internal/hub`: local relay state, board snapshots, presenter lock, viewer
  presence, and broadcast.
- `web/core`: shared browser-side product logic.
- `web/home`: home-page share-link, copy, and QR behavior.
- `web/transports`: event movement adapter for the WebSocket relay.
- `web/board`: Board presenter controller.
- `web/viewer`: Viewer content-only controller.
- `web/assets.go`: embeds the static web app into the Go binary.
- `scripts`: local development and release tooling.
- `tests`: shell, release, and browser smoke checks.

## Routes

- `/`: home page with Board and Viewer links.
- `/board`: presenter surface using the local WebSocket relay.
- `/viewer`: content-only viewer using the local WebSocket relay.
- `/ws/relay`: WebSocket event relay.
- `/api/share`: JSON share metadata for local/LAN URLs.
- `/health`: readiness endpoint.

## Event Model

Onboard syncs drawing events instead of video or bitmap frames.

Why:

- Smaller payloads.
- Easy replay for new viewers.
- Inspectable state transitions.
- Same product model works on Board and Viewer.

Core event types:

- `board:set-surface`
- `stroke:start`
- `stroke:point`
- `stroke:end`
- `stroke:expire`
- `board:undo`
- `board:clear`
- `board:restore`
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

Presenter tools include board surface, compatible pen type, eraser, undo, clear
all, pointer, and ephemeral write.

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

## Viewer Contract

The Viewer is content-only. It shows:

- Board background.
- Strokes.
- Eraser effects.
- Explicit pointer only when the presenter uses pointer mode.
- Unexpired ephemeral strokes.
- Minimal connection/fullscreen feedback.

The Viewer never shows presenter controls.

## State

Board state lives in memory in the local Go process.

- Restarting the server clears the board.
- A newly connected viewer receives the current in-memory board snapshot.
- Persistence is deferred until repeated real use proves it is needed.

## Release Builds

Release binaries are cross-compiled with `CGO_ENABLED=0` using
`/usr/local/go/bin/go build`.

```text
dist/onboard-linux-amd64
dist/onboard-linux-arm64
dist/onboard-windows-amd64.exe
dist/onboard-windows-arm64.exe
dist/onboard-macos-amd64
dist/onboard-macos-arm64
dist/checksums.txt
```

The build script is `scripts/build-release.sh`; its shell check is
`tests/build-release-test.sh`. The release checklist is `docs/release.md`.

## Risks To Watch

- Touch drawing can accidentally scroll the page.
- Canvas sizes must match cleanly between board and viewer.
- Different device pixel ratios can make strokes blurry or offset.
- Reconnect behavior must remain simple and visible when a browser or socket
  drops.
- Viewer must never show board controls.
