# Onboard

Onboard is a compact web app for live board sharing. Run it locally, open the
Board on the drawing device, open the Viewer in the browser tab you share, and
draw without exposing presenter controls.

![Onboard board in blue mode with toolbar and a formula explanation](output/playwright/readme-formula-board.png)

For a technical diagram and event-flow infographic, see
[Software Architecture](docs/how-it-works.md).

## Current App

Onboard currently ships as a Go server with embedded vanilla JavaScript pages.

- `/board` is the presenter surface with controls.
- `/viewer` is the content-only surface for screen sharing.
- `/` links to the local Board and Viewer surfaces.
- `/ws/relay` is the local WebSocket sync path.

The release path is intentionally singular: a Go local WebSocket relay binary.
The user runs one executable on the machine that hosts the board, then opens the
Board and Viewer URLs from browsers on the same LAN.

The printed Board URL contains a random local presenter capability after `#`.
Treat that link as a local secret and use it only on the drawing device. Viewer
URLs contain no capability and are the links intended for screen sharing.

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

## iPhone Viewer App Mode

iPhone Safari does not reliably support JavaScript fullscreen for non-video
pages. To hide Safari browser controls, open `/viewer` in Safari, use
Share -> Add to Home Screen, keep Open as Web App enabled, then open the Viewer
from the Home Screen icon. Onboard includes iOS web app metadata and local icons
for this path. Wake lock remains best-effort and depends on browser support,
secure context, iOS version, and power settings. If the screen still dims after
opening the Viewer from the Home Screen, tap the Viewer once; iOS may require a
user interaction before granting the wake lock.

## Run A Release Binary

End users do not need Go, Node, npm, or any package install. Download the binary
for the machine that will host the board, then run it from a terminal.

Linux and macOS:

```bash
chmod +x ./onboard-linux-amd64
./onboard-linux-amd64
```

Windows:

```powershell
.\onboard-windows-amd64.exe
```

Replace the filename with the matching artifact for your OS and CPU. The app
listens on all local interfaces by default. The terminal and home page
show the local Board/Viewer links and, when possible, direct LAN links for other
devices on the same Wi-Fi/LAN. If another device cannot connect, check that both
devices are on the same network and allow the binary through the operating
system firewall prompt.

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
button remain available if a link is too long for the compact QR size. The app
filters common Docker and VM bridge interfaces out of the main path so the
printed links stay readable. Use `ONBOARD_ADDR` only when you want a custom bind
address or port:

```bash
ONBOARD_ADDR=127.0.0.1:9090 /usr/local/go/bin/go run ./cmd/onboard
```

## Build Release Binaries

```bash
scripts/build-release.sh
```

The release script writes:

- `dist/onboard-linux-amd64`
- `dist/onboard-linux-arm64`
- `dist/onboard-windows-amd64.exe`
- `dist/onboard-windows-arm64.exe`
- `dist/onboard-macos-amd64`
- `dist/onboard-macos-arm64`
- `dist/LICENSE`
- `dist/THIRD_PARTY_NOTICES.md`
- `dist/checksums.txt`

See `docs/release.md` for the release checklist and manual sanity pass.

## Test

```bash
bash tests/build-release-test.sh
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go test ./...
npm run test:js
npm run security:npm
govulncheck ./...
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
internal/server/    HTTP routes, embedded static serving, and relay wiring
internal/hub/       Local WebSocket relay state and broadcast
web/core/           Shared browser product logic
web/board/          Board presenter controller
web/viewer/         Viewer content-only controller
web/transports/     WebSocket relay transport adapter
scripts/            Local development and release tooling
tests/              Shell checks and smoke checks
docs/               Architecture, release, and project notes
```
