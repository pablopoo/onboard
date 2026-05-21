# Roadmap

This project moves in small phases that can be verified manually and with
focused automated checks.

## Completed Baseline

The foundation and baseline app are in place.

Delivered:

- Product objective and working conventions.
- Go executable entrypoint.
- Embedded vanilla JavaScript web app.
- `/`, `/board`, `/viewer`, `/health`, `/api/share`, and `/ws/relay` routes.
- Shared browser core in `web/core`.
- Board presenter controller in `web/board`.
- Viewer content-only controller in `web/viewer`.
- Local WebSocket relay in `internal/hub`.
- WebSocket relay transport.
- Relay reconnect lifecycle status for Board and Viewer.
- Direct startup links for local Board/Viewer and LAN Board/Viewer URLs.
- Startup and home share links prefer physical LAN interfaces and suppress
  noisy Docker/VM bridge addresses unless no better LAN candidate exists.
- Home share rows include local QR codes for opening Board and Viewer links on
  another device without typing the address.
- Board More panel includes a Viewer QR code so the presenter can open a Viewer
  directly from the drawing screen.
- Share links remain usable when a URL is too long for the compact QR code:
  the QR area falls back without breaking the visible URL or copy action.
- Home and Board share copy buttons report clipboard failure instead of showing
  false success when browser copy APIs are blocked or unavailable.
- Predictable default port `8080` with random-port fallback when unavailable.
- Relay viewer-presence status on the Board toolbar.
- Board toolbar Viewer share link under the More control.
- Mobile Board controls use a compact dock that expands into the full toolbar
  and collapses again after compact choices or drawing input.
- Viewer fullscreen/PWA affordances for screen sharing, including iPhone Home
  Screen app mode notes.
- Unit tests for Go server pieces and browser product logic.
- Local browser smoke script covering relay sync, mobile drawing, presenter
  lockout, late-viewer restore, and high-DPR resize behavior.

## Current Architecture Phase: Single Local Runtime

Purpose: keep the product compact and useful without asking users to understand
multiple delivery modes.

The supported path is the local end-user binary:

- Go serves embedded assets.
- Go owns the local WebSocket relay.
- Board and Viewer exchange product events through `/ws/relay`.
- This is the only release path for LAN use and Google Meet screen sharing.

The browser core remains the product boundary. Transport code should not own
drawing semantics.

## Current Product Scope

Board presenter tools:

- Board surface.
- Compatible pen type.
- Viewer share link and QR code.
- Eraser.
- Undo.
- Clear all.
- Pointer.
- Ephemeral write.

Viewer behavior:

- Shows board background, strokes, eraser effects, explicit pointer, and
  unexpired ephemeral strokes.
- Never shows presenter controls.

## Release Build Phase

Purpose: produce simple cross-platform binaries for the local app.

Delivered:

- `scripts/build-release.sh`
- `tests/build-release-test.sh`
- Linux amd64 build.
- Linux arm64 build.
- Windows amd64 build.
- Windows arm64 build.
- macOS amd64 build.
- macOS arm64 build.
- Release checksums.
- Release checklist in `docs/release.md`.

Success check:

```bash
bash tests/build-release-test.sh
scripts/build-release.sh
```

## Future Hardening

Keep future work small and testable.

Likely next areas:

- Packaging notes for unsigned Windows and macOS binaries.
- Optional signing/notarization only if public distribution needs it.
- Persistence only if repeated real use proves it is needed.
- Better recovery copy when firewall or network isolation blocks LAN access.

Deferred:

- Accounts.
- Cloud dependency.
- Persistent multi-board history.
- Complex permissions.
- Multi-presenter collaboration.
- Rich design-tool features.
