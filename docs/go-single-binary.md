# Go Single-Binary LAN Web App

This is the selected product path for Onboard.

Onboard ships as one Go executable per operating system. The executable starts a
local HTTP server, serves the embedded Board and Viewer web UI, and relays board
events over a local WebSocket hub.

## User Experience Goal

The end user should not need Node, Python, npm, package installs, accounts, or a
cloud service.

Expected flow:

1. User runs the `onboard` executable.
2. The app starts a LAN-reachable local web server.
3. The app prints Local, Board, Viewer, and LAN URLs.
4. User opens Board on the drawing device.
5. User opens Viewer in the browser tab shared through Google Meet.

## Runtime Shape

```text
Go executable
  serves embedded web files
  exposes /board, /viewer, /api/share, /health, /ws/relay
  keeps the current board state in memory
  accepts one active Board presenter
  broadcasts board events and snapshots to Viewers

Board browser
  captures drawing input and presenter controls
  sends board events to /ws/relay?role=board

Viewer browser
  connects to /ws/relay?role=viewer
  renders board content only
```

## Cross-Platform Builds

The release script cross-compiles with `CGO_ENABLED=0`:

```bash
GOCACHE=/tmp/onboard-go-build-cache scripts/build-release.sh
```

Expected targets:

```text
dist/onboard-linux-amd64
dist/onboard-linux-arm64
dist/onboard-windows-amd64.exe
dist/onboard-windows-arm64.exe
dist/onboard-macos-amd64
dist/onboard-macos-arm64
dist/checksums.txt
```

## Development Requirements

Development needs Go plus Node/npm for JavaScript tests. End users only need the
prebuilt binary for their operating system.

Go is expected at `/usr/local/go/bin/go`. If a shell was started before Go was
installed, prepend `/usr/local/go/bin` to `PATH` for that shell session.

## Distribution Notes

- Windows Defender Firewall may ask for network permission.
- Unsigned Windows binaries may trigger SmartScreen warnings.
- Unsigned and unnotarized macOS binaries may trigger Gatekeeper warnings.
- Signing and notarization are deferred until public distribution needs them.
- Board state is in memory, so restarting the binary clears the board.
