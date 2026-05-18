# Project Objective

Build a compact web app for live teaching-style drawing with two separate browser experiences.

## Core Scenario

A presenter wants to draw naturally on a tablet or phone while sharing a clean board view in a video call.

The presenter opens:

- A **board window** on the device used for drawing.
- A **viewer window** on the device or browser tab shared in Google Meet.

The viewer must show what was drawn, not the drawing controls.

## Essential Requirements

- The app runs locally and is reachable by other devices on the same local network.
- The board supports drawing on a surface similar to a school board.
- The board supports four board surfaces:
  - Whiteboard: marker tools.
  - Blackboard: chalk tools.
  - Greenboard: chalk tools.
  - Blueboard: marker tools.
- The viewer mirrors the board drawing output.
- The viewer hides all controls.
- The presenter has controls for board type, compatible pen type, clear all, eraser, pointer, and ephemeral writing.
- Pointer display is explicit, not automatic.
- Ephemeral writing is temporary: strokes fade or disappear after a configured number of seconds.
- The first implementation should be small and understandable.

## Presenter Tools

Presenter controls belong only on the Board surface:

- Board type selector.
- Tool selector constrained by board type.
- Clear all.
- Eraser.
- Pointer.
- Ephemeral write mode.

The Viewer surface must show board content only:

- Current board background.
- Drawing strokes.
- Eraser effects.
- Explicit pointer when active.
- Ephemeral strokes until they expire.

The Viewer must not show drawing tools, selectors, or presenter-only controls.

## Design Priorities

1. **Compactness:** fewer files, fewer dependencies, fewer concepts.
2. **Reliability:** drawing sync should be predictable on a LAN.
3. **Usability:** the board and viewer URLs should be easy to open.
4. **Separation:** presenter controls must not leak into the shared viewer.
5. **Iteration:** each phase should produce a working slice or a useful project artifact.

## Open Decisions

- Whether first persistence is in-memory only or file-backed.
- Exact visual treatment for chalk versus marker strokes.
- Exact default expiration time for ephemeral writing.
