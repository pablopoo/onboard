# Approach 3: Hosted WebRTC P2P App

## Summary

Host Onboard as a web app with a signaling server. Users open the hosted app in two browsers, pair the board and viewer, then send drawing data directly between browsers using a WebRTC DataChannel.

The hosted server is used for app delivery, discovery, pairing, and reconnect signaling. It does not need to carry every drawing event when the peer-to-peer connection succeeds.

## User Experience Goal

The end user should not install anything.

Expected flow:

1. User opens the hosted Onboard URL.
2. User creates or joins a board session.
3. The app shows a Viewer link or QR code.
4. User opens Viewer on the shared browser tab.
5. Board and Viewer pair through the hosted signaling server.
6. Drawing data flows directly over WebRTC when possible.

## Proposed Structure

```text
server/
  signaling-server
web/
  index.html
  board.html
  viewer.html
  board.js
  viewer.js
  webrtc.js
  canvas.js
  styles.css
```

The exact server runtime is an open decision. A Node.js signaling server is common, but the signaling server could also be written in Go or another backend.

## Runtime Architecture

```text
Hosted Onboard server
  serves web app
  creates sessions
  exchanges WebRTC signaling messages
  may help reconnect paired browsers

Board browser
  opens hosted /board session
  captures drawing input
  sends drawing events over WebRTC DataChannel

Viewer browser
  opens hosted /viewer session
  receives drawing events over WebRTC DataChannel
  renders output only
```

## Data Flow

Setup path:

```text
Board browser -> hosted signaling server -> Viewer browser
Viewer browser -> hosted signaling server -> Board browser
```

Drawing path when peer-to-peer succeeds:

```text
Board browser -> WebRTC DataChannel -> Viewer browser
```

Fallback path if a direct peer-to-peer path is blocked:

```text
Board browser -> TURN relay -> Viewer browser
```

The fallback still uses WebRTC encryption, but relay capacity becomes an infrastructure concern.

## Signaling

WebRTC cannot connect two browsers without some rendezvous mechanism.

The signaling server exchanges:

- Session identity.
- WebRTC offer.
- WebRTC answer.
- ICE candidates.
- Pairing and reconnect messages.

The signaling server does not need to understand drawing events if the WebRTC DataChannel is established successfully.

## Discovery And Pairing

Possible pairing models:

- Session link.
- QR code.
- Short pairing code.
- Public room.
- Previously paired devices.

For Onboard, the simplest likely model is:

```text
Board creates session -> Viewer scans QR or opens link -> browsers pair
```

## Development Environment Requirement

This approach requires:

- Frontend web app.
- Hosted signaling backend.
- Deployment target for the signaling server.
- HTTPS, because modern WebRTC behavior and browser APIs expect secure contexts outside localhost.

Local development can run on localhost, but real use requires hosted infrastructure.

## Distribution Notes

End users:

- No local install.
- No local server.
- Open a URL.

Project operator:

- Must host the app.
- Must operate the signaling server.
- May need STUN/TURN configuration.
- May need monitoring and rate limits if public.

## Advantages

- Lowest install friction for users.
- Works from a normal hosted URL.
- Drawing traffic can avoid the server when WebRTC connects directly.
- A PairDrop-style pairing experience is possible.
- Good fit if the project becomes a public web app.

## Costs And Risks

- More complex than local server approaches.
- Requires hosted infrastructure.
- Requires signaling logic.
- WebRTC debugging is harder than WebSocket debugging.
- NAT/firewall edge cases can prevent direct peer-to-peer paths.
- TURN relay may be needed for reliability.
- TURN relay traffic can create bandwidth and cost concerns.
- Offline LAN-only use is not the default unless the signaling server is also available locally.

## Fit For Onboard

This approach is a strong candidate if the project optimizes for:

```text
open hosted URL, pair devices, draw
```

It is weaker if the project must work fully offline on a local network with no hosted dependency.

