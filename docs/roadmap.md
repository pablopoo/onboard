# Roadmap

This project moves in small phases that can be verified manually and with
focused automated checks.

## Completed Baseline

The foundation and baseline app are in place.

Delivered:

- Product objective and working conventions.
- Go executable entrypoint.
- Embedded vanilla JavaScript web app.
- `/`, `/board`, `/viewer`, `/health`, `/ws/relay`, and `/signal` routes.
- Shared browser core in `web/core`.
- Board presenter controller in `web/board`.
- Viewer content-only controller in `web/viewer`.
- Approach 1 local WebSocket relay in `internal/hub`.
- Approach 3 signaling registry in `internal/signaling`.
- WebSocket relay transport.
- WebRTC DataChannel transport.
- Relay reconnect lifecycle status for Board and Viewer.
- Direct startup links for local Board/Viewer and LAN Board/Viewer URLs.
- Startup and home share links prefer physical LAN interfaces and suppress
  noisy Docker/VM bridge addresses unless no better LAN candidate exists.
- Home share rows include local QR codes for opening Board and Viewer links on
  another device without typing the address.
- Board More panel includes a Viewer QR code so the presenter can pair/open a
  Viewer directly from the drawing screen.
- WebRTC Board sharing waits for a real session URL before enabling Viewer
  open/copy actions, avoiding incomplete hosted Viewer links.
- WebRTC signaling socket drops after connection are surfaced to pending
  Board/Viewer setup instead of leaving the pairing flow waiting forever.
- WebRTC DataChannel setup fails fast and cleans up when signaling reports an
  error, such as an unknown or expired session.
- WebRTC data-channel reconnect failures are reported through Board/Viewer
  error paths while still updating visible disconnected status.
- WebRTC Board input queues while the data channel is reconnecting and flushes
  when the channel returns, without overwriting the WebRTC session label.
- WebRTC Board sends a current board snapshot when the data channel reconnects
  so a reloaded/rejoined Viewer receives existing writing.
- Share links remain usable when a URL is too long for the compact QR code:
  the QR area falls back without breaking the visible URL or copy action.
- Home and Board share copy buttons report clipboard failure instead of showing
  false success when browser copy APIs are blocked or unavailable.
- Predictable default port `8080` with random-port fallback when unavailable.
- Browser-level relay reconnect smoke coverage.
- Relay viewer-presence status on the Board toolbar.
- Board toolbar Viewer share link under the More control.
- Mobile Board controls use a compact bottom dock that expands into the full
  toolbar and collapses again after compact choices or drawing input.
- WebRTC disconnect lifecycle status for Board and Viewer.
- Same-session WebRTC data-channel reconnect behavior for Board and Viewer.
- Browser-level WebRTC reconnect smoke coverage.
- Unit tests for Go server pieces and browser product logic.
- Local browser smoke script covering relay sync, mobile drawing, presenter
  lockout, WebRTC pairing, and high-DPR resize behavior.

## Current Architecture Phase: Dual Runtime Paths

Purpose: keep one product implementation while supporting the two useful
delivery models.

Approach 1 is the local end-user binary:

- Go serves embedded assets.
- Go owns the local WebSocket relay.
- Board and Viewer exchange product events through `/ws/relay`.
- This is the default route for LAN use and Google Meet screen sharing.

Approach 3 is the no-install hosted pairing path:

- Go serves the same browser app.
- Go owns hosted signaling through `/signal`.
- Board and Viewer pair, then exchange product events over WebRTC DataChannel.
- This path is for hosted use where users open a URL instead of running a local
  binary.

The shared browser core remains the product boundary. Transport code should not
own drawing semantics.

## Current Product Scope

Board presenter tools:

- Board surface.
- Compatible pen type.
- Viewer share link and QR code.
- Eraser.
- Clear all.
- Pointer.
- Ephemeral write.

Viewer behavior:

- Shows board background, strokes, eraser effects, explicit pointer, and
  unexpired ephemeral strokes.
- Never shows presenter controls.

## Release Build Phase

Purpose: produce simple cross-platform binaries for the local Approach 1 app.

Delivered by Packet P16:

- `scripts/build-release.sh`
- `tests/build-release-test.sh`
- Linux amd64 build.
- Windows amd64 build.
- macOS amd64 build.
- macOS arm64 build.

Success check:

```bash
bash tests/build-release-test.sh
scripts/build-release.sh
```

## Future Hardening

Keep future work small and testable.

Likely next areas:

- WebRTC hosted deployment notes, HTTPS requirements, and failure states.
- Packaging notes for unsigned Windows and macOS binaries.
- Optional signing/notarization only if public distribution needs it.
- Persistence only if repeated real use proves it is needed.

Deferred:

- Accounts.
- Cloud dependency for the local binary workflow.
- Persistent multi-board history.
- Complex permissions.
- Multi-presenter collaboration.
- Rich design-tool features.
