# Architecture Notes

This is the initial direction, not a final contract.

## Proposed Shape

Use a small local server that serves the board and viewer pages and owns live synchronization.

```text
Drawing device
  /board
  canvas + controls
  sends stroke events

Local server
  static pages
  WebSocket hub
  in-memory board state

Shared browser tab
  /viewer
  canvas only
  receives stroke events
```

## Routes

- `/board`: presenter surface with drawing tools.
- `/viewer`: clean output surface for screen sharing.
- `/health`: simple readiness endpoint if useful.

## Sync Model

Start with stroke events instead of video streaming or bitmap streaming.

Why:

- Smaller payloads.
- Easy to replay for new viewers.
- Easier to support undo later.
- Keeps implementation inspectable.

Initial event types can be:

- `stroke:start`
- `stroke:point`
- `stroke:end`
- `board:clear`
- `pointer:show`
- `pointer:move`
- `pointer:hide`

## State

Initial state should be in memory.

That means:

- Restarting the server clears the board.
- A newly connected viewer receives current in-memory strokes.
- Persistence is deferred until there is a real need.

## First Stack Preference

The first implementation should prefer the smallest stack that handles:

- HTTP static serving.
- WebSocket connections.
- Simple browser JavaScript.

A likely candidate is Node.js with a minimal server and the `ws` package, but that decision belongs to Phase 02.

## Risks To Watch

- Touch drawing can accidentally scroll the page.
- Canvas sizes must match cleanly between board and viewer.
- Different device pixel ratios can make strokes blurry or offset.
- WebSocket reconnects need simple behavior before real use.
- Viewer must never show board controls.

