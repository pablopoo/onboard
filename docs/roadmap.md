# Roadmap

This project should move in phases. Each phase should stay small enough to verify manually.

## Phase 01: Foundation

Purpose: establish the project structure and working conventions.

Deliverables:

- `AGENTS.md`
- `README.md`
- Project objective document
- Roadmap
- Architecture notes
- Codex role files
- First phase task note

No app code in this phase.

## Phase 02: Minimal Local App

Purpose: prove that the app can run locally and expose two routes.

Expected deliverables:

- Local web server
- `/board` route
- `/viewer` route
- Basic static pages
- LAN-friendly startup instructions

Success check:

- Board and viewer open in separate browser windows.
- Another device on the same LAN can reach the app by host IP and port.

## Phase 03: Drawing Surface

Purpose: make the board usable as a simple drawing surface.

Expected deliverables:

- Canvas drawing surface
- Pen input and mouse input
- Board surfaces: whiteboard, blackboard, greenboard, blueboard
- Compatible tools: markers for white/blue boards, chalk for black/green boards
- Basic stroke width
- Clear board action

Success check:

- Drawing works from a touch device.
- The page does not scroll while drawing.
- Viewer shows the selected board surface and content, not presenter controls.

## Phase 04: Live Viewer Sync

Purpose: mirror board drawing to the viewer.

Expected deliverables:

- WebSocket connection
- Stroke event protocol
- In-memory board state
- Viewer replay of current state on connect

Success check:

- Drawing on the board appears in the viewer with low latency.
- Reloading the viewer restores current board contents.

## Phase 05: Presenter Tools

Purpose: add only the controls needed for real teaching use.

Expected deliverables:

- Explicit pointer mode
- Undo
- Eraser
- Clear all
- Ephemeral write mode with automatic expiration
- Minimal visual polish
- Basic connection status

Success check:

- Presenter can draw, erase, point, write temporarily, undo, and clear without exposing controls to the viewer.

## Phase 06: Hardening

Purpose: make the app dependable for repeated local use.

Expected deliverables:

- Mobile layout fixes
- Reconnect behavior
- Basic automated tests
- Manual test checklist
- Packaging/start command cleanup

Success check:

- A fresh user can start the app and use it from two local devices using the README.
