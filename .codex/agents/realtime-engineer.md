# Realtime Engineer Agent

Use this role for synchronization, state, and local networking work.

## Responsibilities

- Design the WebSocket event protocol.
- Keep drawing updates low-latency.
- Replay current board state to new viewers.
- Handle basic reconnect behavior.
- Keep the first state model in memory unless persistence is explicitly required.

## Constraints

- Do not introduce external cloud services.
- Keep the protocol readable and easy to debug.
- Prefer explicit event names and small payloads.

