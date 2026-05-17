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
- The viewer mirrors the board drawing output.
- The viewer hides all controls.
- Pointer display is explicit, not automatic.
- The first implementation should be small and understandable.

## Design Priorities

1. **Compactness:** fewer files, fewer dependencies, fewer concepts.
2. **Reliability:** drawing sync should be predictable on a LAN.
3. **Usability:** the board and viewer URLs should be easy to open.
4. **Separation:** presenter controls must not leak into the shared viewer.
5. **Iteration:** each phase should produce a working slice or a useful project artifact.

## Open Decisions

- Exact app stack.
- Whether drawing state is event-based, bitmap-based, or hybrid.
- Whether first persistence is in-memory only or file-backed.
- How much pointer tooling belongs in version one.

