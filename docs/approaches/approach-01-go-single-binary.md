# Approach 1: Go Single-Binary LAN Web App

## Summary

Build Onboard as a Go application that ships as one executable per operating system and serves the board/viewer web UI from embedded files.

The app remains browser-based. Go is used for packaging, local serving, and realtime sync.

## User Experience Goal

The end user should not need Node, Python, npm, package installs, or a build step.

Expected flow:

1. User runs the `onboard` executable.
2. The app starts a local web server.
3. The default browser opens to a local home page.
4. The home page shows:
   - Board URL
   - Viewer URL
   - QR code for Board
   - QR code for Viewer
5. User opens Board on the drawing device.
6. User shares Viewer in Google Meet.

## Proposed Structure

```text
cmd/onboard/main.go
internal/server/
internal/hub/
web/
  index.html
  board.html
  viewer.html
  board.js
  viewer.js
  canvas.js
  styles.css
```

## Runtime Architecture

```text
Go executable
  starts HTTP server on 0.0.0.0
  serves embedded web files
  manages realtime sync
  keeps board state in memory

Board browser
  opens /board
  captures drawing input
  sends drawing events

Viewer browser
  opens /viewer
  receives drawing events
  renders output only
```

## Realtime Sync

Preferred sync channel: WebSocket.

Why:

- Browser support is mature.
- Bidirectional communication is available if needed.
- Low-latency drawing sync is straightforward.
- Go has good WebSocket libraries.

SSE remains possible, but WebSocket is likely a better fit once pointer mode, reconnect behavior, and future control messages are considered.

## Cross-Platform Builds

Go can cross-compile from Linux to Windows, Linux, and macOS if the project avoids CGO/native C dependencies.

Recommended build setting:

```bash
CGO_ENABLED=0
```

Example build targets:

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/onboard-linux-amd64 ./cmd/onboard
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o dist/onboard-windows-amd64.exe ./cmd/onboard
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -o dist/onboard-macos-amd64 ./cmd/onboard
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o dist/onboard-macos-arm64 ./cmd/onboard
```

Additional targets can be added later:

```bash
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o dist/onboard-linux-arm64 ./cmd/onboard
GOOS=windows GOARCH=arm64 CGO_ENABLED=0 go build -o dist/onboard-windows-arm64.exe ./cmd/onboard
```

## Development Environment Requirement

The development machine needs the Go toolchain installed.

Environment check on 2026-05-17 before installation:

```text
go: command not found
```

After running `scripts/install-go-latest.sh`, Go is installed at:

```text
/usr/local/go/bin/go
go version go1.26.3 linux/amd64
```

The current Codex shell may still need `/usr/local/go/bin` added to `PATH` before plain `go` works.

End users do not need Go if they receive prebuilt binaries.

## Distribution Notes

Windows:

- A `.exe` can be cross-compiled from Linux.
- Windows Defender Firewall may ask for network permission.
- Unsigned executables may trigger SmartScreen warnings.

macOS:

- macOS binaries can be cross-compiled from Linux.
- Unsigned and unnotarized binaries may trigger Gatekeeper warnings.
- Polished public distribution would eventually require signing and notarization from macOS with an Apple Developer account.

Linux:

- A static Linux binary should be straightforward if `CGO_ENABLED=0`.

## Advantages

- Best practical end-user simplicity without building a full desktop app.
- No runtime dependency for users.
- Cross-platform releases are realistic.
- One process owns local serving and sync.
- Browser UI keeps the app portable and inspectable.
- Strong fit for LAN-first use.

## Costs And Risks

- Go must be installed for development.
- More initial structure than a Python script.
- WebSocket dependency decision is still needed.
- Browser auto-open behavior is OS-specific.
- Firewall and OS security prompts cannot be fully avoided.
- Signing may be needed for smoother Windows/macOS distribution.

## Fit For Onboard

This approach is a strong candidate if the project optimizes for end-user simplicity over developer setup simplicity.

It is likely the best option if the final product should feel like:

```text
download one file, run it, open board/viewer URLs
```
