# Approach 2: Node.js Power-User Server

## Summary

Build Onboard as a small Node.js web server that serves the board/viewer UI and manages realtime sync.

This approach targets power users, developers, and technically comfortable users. It is less suitable for non-technical end users because it requires Node.js and command-line startup unless later packaged.

## User Experience Goal

The expected user is comfortable with:

- Installing Node.js.
- Running commands in a terminal.
- Starting and stopping a local server.
- Reading a printed local URL.
- Finding the host machine IP address if needed.

Expected flow:

1. User installs Node.js.
2. User gets the project files.
3. User runs `npm install`.
4. User runs `npm start`.
5. Terminal prints local and LAN URLs.
6. User opens Board on the drawing device.
7. User shares Viewer in Google Meet.

## Proposed Structure

```text
package.json
server.js
public/
  index.html
  board.html
  viewer.html
  board.js
  viewer.js
  canvas.js
  styles.css
```

## Runtime Architecture

```text
Node.js process
  starts HTTP server on 0.0.0.0
  serves public files
  manages realtime sync
  keeps board state in memory

Board browser
  opens /board
  captures drawing input
  sends drawing events

Viewer browser
  opens /viewer
  receives drawing events
  renders output only
```

## Realtime Sync

Preferred sync channel: WebSocket using the `ws` package.

Why:

- Simple API.
- Mature package.
- Good fit for low-latency drawing events.
- Keeps server code compact.

SSE is possible, but WebSocket is a better fit if the board and server need bidirectional status, reconnect, pointer, and control messages.

## Development Environment Requirement

The machine running the app needs:

- Node.js
- npm
- Project dependencies installed with `npm install`

Unlike the Go single-binary approach, the runtime is required on the user's machine unless the app is later packaged.

## Distribution Notes

Basic distribution:

- Share the source folder.
- User runs `npm install`.
- User runs `npm start`.

Improved distribution:

- Package the Node app into an executable with a tool such as `pkg` or `nexe`.
- This reduces end-user setup but adds packaging complexity and possible native compatibility issues.

## Advantages

- Very fast to prototype.
- Small amount of code.
- Large ecosystem.
- WebSocket support is straightforward.
- Easy for developers to inspect and modify.
- Good fit for a power-user tool or internal utility.

## Costs And Risks

- Requires Node.js and npm on the runtime machine.
- `npm install` adds setup friction.
- Dependency management becomes part of the project.
- Less polished for non-technical users.
- The server must be started from a terminal unless later wrapped.
- Packaging into a single executable is possible but less clean than Go.

## Fit For Onboard

This approach is a good candidate if the project optimizes for speed of development and power-user flexibility.

It is less attractive if the primary goal is:

```text
download one file, run it, draw
```

It is more attractive if the primary goal is:

```text
clone project, run server, customize behavior
```

