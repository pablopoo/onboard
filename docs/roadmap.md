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
- Unit tests for Go server pieces and browser product logic.
- Local browser smoke script.

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

- LAN startup polish: clearer host/IP output, optional fixed default port, QR
  links for Board and Viewer.
- Reconnect behavior for relay and WebRTC transports.
- WebRTC hosted deployment notes, HTTPS requirements, and failure states.
- Manual browser smoke coverage for the WebRTC pairing path.
- Canvas resize and device-pixel-ratio checks across common devices.
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
