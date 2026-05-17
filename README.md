# Onboard

Onboard is a compact local-network web app for using one browser as a drawing board and another browser as a clean shared viewer.

The intended workflow:

1. Start the app on a computer in the local network.
2. Open the board URL on a tablet, phone, or laptop.
3. Open the viewer URL in another browser window or device.
4. Share the viewer tab in Google Meet.
5. Draw from the board device while viewers see only the drawing output.

## Goals

- Minimal setup.
- Local network first.
- Clean separation between drawing controls and shared output.
- Low-latency drawing sync.
- Small codebase that is easy to inspect and change.

## Non-Goals For The First Version

- User accounts.
- Cloud hosting.
- Persistent multi-board history.
- Complex permissions.
- Collaborative editing by many writers.
- Rich design-tool features.

## Project Structure

```text
AGENTS.md                    Project instructions for Codex and agentic work
README.md                    Human-facing project overview
docs/project-objective.md    Product goal and constraints
docs/roadmap.md              Phase-by-phase plan
docs/architecture.md         Initial architecture direction
.codex/agents/               Role prompts for focused Codex work
.codex/tasks/                Phase task notes
.agents/README.md            Notes for local agent/plugin workspace
```

## Current Status

Phase 01 foundation is being established. App code starts in a later phase.

