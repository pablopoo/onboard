# Release Checklist

Onboard's production path is the Go single-binary local relay app. Node is used
only for JavaScript tests and npm audit.

## Tooling

- Go: `/usr/local/go/bin/go`, matching `go.mod`.
- Node: version in `.nvmrc` and `.node-version`.
- npm: version in `package.json`.
- Playwright CLI/browser binaries for `tests/local-browser-smoke.sh`.

Do not add runtime dependencies for end users unless the product goal changes.

## Fresh Verification

Run these from the repository root before cutting a release:

```bash
bash tests/install-go-latest-test.sh
bash tests/build-release-test.sh
npm run test:js
npm run security:npm
govulncheck ./...
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go test ./...
timeout 180s tests/local-browser-smoke.sh
git diff --check
cd dist && sha256sum -c checksums.txt
```

The local browser smoke test starts a temporary Go server, opens Board and
Viewer in real browser contexts, draws, syncs, clears, checks viewer-only UI,
and exercises relay reconnect, snapshot, and multi-viewer behavior.

## Build Artifacts

Build with:

```bash
GOCACHE=/tmp/onboard-go-build-cache scripts/build-release.sh
```

Set `DIST_DIR` to write a release into another directory without removing or
overwriting unrelated files in `dist/`:

```bash
DIST_DIR=/tmp/onboard-release GOCACHE=/tmp/onboard-go-build-cache scripts/build-release.sh
```

Expected outputs:

```text
dist/onboard-linux-amd64
dist/onboard-linux-arm64
dist/onboard-windows-amd64.exe
dist/onboard-windows-arm64.exe
dist/onboard-macos-amd64
dist/onboard-macos-arm64
dist/LICENSE
dist/THIRD_PARTY_NOTICES.md
dist/checksums.txt
```

The release script cross-compiles with `CGO_ENABLED=0`, strips platform-local
paths and debug symbols, and requires `sha256sum` or `shasum`. The checksum
manifest covers all six binaries plus the project and dependency notices.
Verify it from inside the selected release directory because it stores artifact
basenames.

## Manual Sanity Pass

Use a built binary, not `go run`, for this pass.

1. Start the binary and confirm it prints Local, Board, Viewer, and LAN links.
2. Open Board and Viewer on the same machine.
3. Open Viewer from another device on the same Wi-Fi/LAN.
4. Scan the Viewer QR from the Board share panel.
5. Draw marker strokes on whiteboard and blueboard.
6. Draw chalk strokes on blackboard and greenboard.
7. Change tip size and eraser size, then erase part of a stroke.
8. Use Pointer and confirm it appears only while active.
9. Use Fade and confirm temporary strokes expire.
10. Use Clear, confirm the destructive button label fits, then clear.
11. Collapse and expand the toolbar on a phone-sized viewport.
12. Open Viewer on iPhone Safari through Add to Home Screen and confirm browser
    controls are hidden in app mode.

## Known Release Notes

- Board state is in memory. Restarting the binary clears the board.
- Firewall prompts are expected on Windows and some macOS/Linux setups.
- Unsigned Windows and macOS binaries can trigger SmartScreen or Gatekeeper
  warnings. Signing/notarization is deferred until public distribution needs it.
- iOS fullscreen requires Home Screen app mode. Wake lock is best-effort because
  mobile browsers and power settings can still dim the screen.
