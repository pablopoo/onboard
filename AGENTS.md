# AGENTS.md

Direct and pragmatic. Be honest.

## Project Objective

Build the most compact useful web app for live board sharing on a local network.

The app has two browser surfaces:

- **Board:** opened on a tablet, phone, or laptop. It has drawing controls and a writable surface like a classroom board.
- **Viewer:** opened in another browser window or device. It shows only the drawing output, with no drawing controls. It may show an explicit pointer only when the presenter chooses to use one.

Primary use case: share the viewer tab in Google Meet while drawing from another device.

## Product Constraints

- Must run locally and be reachable from other devices on the same LAN.
- Must be compact. Prefer fewer moving parts until a real need appears.
- Must not require accounts, cloud services, or external infrastructure for the core workflow.
- Must keep presenter controls out of the shared viewer.
- Must make the happy path obvious: start app, open board, open viewer, draw.

## Core App Requirements

- Support whiteboard and blueboard surfaces with marker tools.
- Support blackboard and greenboard surfaces with chalk tools.
- Keep drawing controls on the Board only.
- Keep the Viewer content-only: board background, strokes, eraser effects, explicit pointer, and unexpired ephemeral strokes.
- Presenter tools include board surface, compatible pen type, eraser, clear all, pointer, and ephemeral write mode.
- Image generation may be used for board surface textures, icon references, visual references, and lightweight UI assets when useful. Do not use generated images as a substitute for the core drawing, sync, or canvas logic.

## Engineering Direction

Default technical direction until proven otherwise:

- A small local web server.
- One route for the board.
- One route for the viewer.
- WebSocket-based sync between board and viewer.
- Canvas-based rendering first, unless a later phase proves SVG or a library is better.

Follow the project tree documented in `docs/architecture.md`. Keep shared browser product logic in `web/core`, runtime adapters in `web/transports`, Go local relay code in `internal/hub`, and hosted WebRTC signaling code in `internal/signaling`.

## Working Rules For Codex

- Before editing, inspect existing files and follow the established structure.
- Keep changes scoped to the current phase.
- Do not add frameworks, build tools, or dependencies without a concrete reason.
- Prefer readable boring code over abstractions.
- Document phase decisions when they affect later implementation.
- Verify work before claiming it is complete.

## Current Phase

Phase 01 is foundation only:

- Define product objective.
- Define repository structure.
- Define agent responsibilities.
- Define phased roadmap.
- Avoid app implementation until the foundation is clear.
