# Onboard

Onboard is a compact web app for live board sharing. Run it locally, open the
Board on the drawing device, open the Viewer in the browser tab you share, and
draw without exposing presenter controls.

## Current App

Onboard currently ships as a Go server with embedded vanilla JavaScript pages.

- `/board` is the presenter surface with controls.
- `/viewer` is the content-only surface for screen sharing.
- `/` links to the local relay surfaces and the WebRTC pairing surfaces.
- `/ws/relay` is the local WebSocket sync path.
- `/signal` is the WebRTC signaling path.

The end-user local binary uses Approach 1: a Go local WebSocket relay. The
no-install hosted pairing path uses Approach 3: Go hosted signaling plus a
WebRTC DataChannel between browsers.

## Presenter And Viewer

Presenter tools on the Board include:

- Board surface: whiteboard, blueboard, blackboard, or greenboard.
- Compatible pen type: marker for whiteboard/blueboard, chalk for
  blackboard/greenboard.
- Viewer share link with QR code.
- Eraser.
- Clear all.
- Pointer.
- Ephemeral write.

The Viewer shows only board content: board background, strokes, eraser effects,
the explicit pointer when active, and unexpired ephemeral strokes. It never shows
presenter controls.

## Run From Source

Development uses the Go toolchain at `/usr/local/go/bin/go`.

```bash
/usr/local/go/bin/go run ./cmd/onboard
```

By default, the app listens on port `8080`. If that port is already in use, it
falls back to a random available port and prints the actual links.

The terminal and home page print direct Board and Viewer links for this
computer and, when available, the most likely direct LAN Board and Viewer links
for another device. The home page and Board share panel also show QR codes for
those links when they fit the compact local QR size; the visible URL and Copy
button remain available if a hosted link is too long. The app filters common
Docker and VM bridge interfaces out of the main path so the printed links stay
readable. Use `ONBOARD_ADDR` only when you want a custom bind address or port:

```bash
ONBOARD_ADDR=127.0.0.1:9090 /usr/local/go/bin/go run ./cmd/onboard
```

## Build Release Binaries

```bash
scripts/build-release.sh
```

The release script writes:

- `dist/onboard-linux-amd64`
- `dist/onboard-windows-amd64.exe`
- `dist/onboard-macos-amd64`
- `dist/onboard-macos-arm64`

## Test

```bash
bash tests/build-release-test.sh
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go test ./...
npm run test:js
npm run security:npm
bash tests/local-browser-smoke.sh
git diff --check
```

## Dependency Security

Keep the dependency surface small. Go dependencies are pinned by `go.mod` and
`go.sum`; npm is pinned by `package.json`, `.npmrc`, and `package-lock.json`.
See `docs/security.md` before adding any package.

## Project Structure

```text
cmd/onboard/        Go executable entrypoint
internal/server/    HTTP routes, embedded static serving, relay and signaling wiring
internal/hub/       Approach 1 local WebSocket relay state and broadcast
internal/signaling/ Approach 3 pairing and WebRTC signaling registry
web/core/           Shared browser product logic
web/board/          Board presenter controller
web/viewer/         Viewer content-only controller
web/transports/     WebSocket relay and WebRTC DataChannel transport adapters
scripts/            Local development and release tooling
tests/              Shell checks and smoke checks
docs/               Architecture, roadmap, and approach notes
```
