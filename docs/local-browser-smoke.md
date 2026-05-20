# Local Browser Smoke Checks

Run the repeatable smoke check from the repository root:

```bash
tests/local-browser-smoke.sh
```

The script builds a temporary local Go binary with:

```bash
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go build -o "$tmpdir/onboard" ./cmd/onboard
```

Then it starts that binary with:

```bash
ONBOARD_ADDR=127.0.0.1:0 "$tmpdir/onboard"
```

It parses the printed Board and Viewer URLs, then drives a real browser through `playwright-cli`. If `playwright-cli` is not on `PATH`, it falls back to `$HOME/.codex/skills/playwright/scripts/playwright_cli.sh`.

The check verifies:

- `/` renders share rows with copy buttons and QR codes for Board and Viewer links.
- `/board` loads without browser console or page errors.
- `/board` has a visible canvas, presenter toolbar, expected presenter controls, and a Viewer share link panel with a QR code.
- `/board` at a phone-sized viewport starts with the compact mobile dock visible and the toolbar collapsed.
- The mobile toolbar can expand without overflowing the viewport, shows a visible minimize control, and collapses again through that control.
- Drawing from a phone-sized Board with the compact dock collapsed reaches a connected Viewer.
- High-DPR phone and tablet-sized boards keep canvas backing stores aligned with display size, and drawing still reaches the Viewer after resize.
- Changing the Board surface updates the connected viewer canvas surface color.
- Drawing a marker stroke in the board tab changes pixels in a simultaneously connected viewer tab.
- Forcibly closing the Board and Viewer relay sockets reconnects them, and drawing
  after reconnect still reaches the Viewer.
- Drawing a marker stroke reaches two simultaneously connected viewer tabs.
- A second Board tab is locked out while the first presenter is active and cannot change connected viewers.
- Clearing the board after drawing removes the ink from the connected viewer tab.
- Eraser mode removes marker ink from the connected viewer tab.
- Pointer mode shows an explicit pointer in the connected viewer and hides it after release.
- Fade mode shows temporary ink in the connected viewer and removes it after expiration.
- A viewer opened after the board already has writing renders the current board state from the relay snapshot.
- The Board toolbar reports relay viewer presence after a Viewer is connected.
- WebRTC Board creates a session, a session-linked WebRTC Viewer connects, and drawing reaches the Viewer over the data channel.
- Forcibly closing the WebRTC data channel reconnects Board and Viewer in the
  same session, and drawing after reconnect still reaches the Viewer.
- Closing and reopening the WebRTC Viewer with the same session URL receives
  the current board state from the Board snapshot sync.
- `/viewer` loads without browser console or page errors.
- `/viewer` has a visible canvas and no board controls, buttons, selects, inputs, or toolbar markup.
- `/viewer` reports `Connected` through hidden status metadata within the timeout.
- `/viewer` shows no persistent non-board status text after connecting.

The script cleans up the Playwright session and the Go server on exit.

Environment-dependent pieces:

- Go must be available at `/usr/local/go/bin/go`.
- A working Playwright CLI or the bundled wrapper must be available.
- The wrapper depends on `npx` and may need browser binaries already installed in the user environment.
- The temporary directory must allow executing the built server binary.
- Local socket binding on `127.0.0.1:0` must be permitted.

Manual fallback, if browser automation is unavailable:

1. Build and start the app with the commands above.
2. Open the local home URL and confirm the share rows include Board and Viewer links, copy buttons, and QR codes.
3. Open the printed Board URL and confirm the canvas and presenter controls are visible with no DevTools console errors.
4. Resize the Board browser to a phone-sized viewport and confirm the compact dock appears, the full toolbar opens from it, the toolbar stays within the viewport, and the minimize control collapses it.
5. With the Board still phone-sized and the compact dock collapsed, draw on the canvas and confirm the Viewer receives the stroke.
6. On a high-density device if available, draw from phone and tablet-sized browser windows and confirm the Viewer receives strokes after each resize.
7. Change the Board surface to Green and back to White, and confirm the Viewer surface follows those changes.
8. Open the Board URL and Viewer URL in two tabs at the same time, draw one marker stroke on the board, and confirm the viewer output changes.
9. To manually mimic the reconnect check, disable and re-enable the network connection for either tab, wait for it to show connected again, then draw and confirm the Viewer updates.
10. Open a second Viewer tab, draw one marker stroke on the Board, and confirm both Viewer tabs update.
11. Open a second Board tab while the first Board remains open, confirm it reports another active presenter, and confirm drawing there does not change the Viewer.
12. Press Clear twice on the Board and confirm the Viewer output clears too.
13. Draw another marker stroke, select Eraser, erase across it, and confirm the Viewer output removes that ink.
14. Select Pointer on the Board, press on the canvas, confirm the Viewer shows the pointer, then release and confirm it hides.
15. Enable Fade on the Board, draw one stroke, confirm the Viewer shows it, then confirm the stroke disappears after expiration.
16. Close the Viewer tab, draw or keep existing writing on the Board, reopen the Viewer URL, and confirm the writing is visible without touching the Board again.
17. Open `/board?transport=webrtc`, copy the session-linked Viewer URL shown in the Board status, open that Viewer URL, draw on the Board, and confirm the Viewer receives the stroke.
18. To manually mimic the WebRTC reconnect check, temporarily interrupt one peer connection, wait for the Viewer to report connected again, then draw and confirm the Viewer updates.
19. Open the printed Viewer URL and confirm it shows only viewer output markup, with no buttons, selects, inputs, toolbar, or persistent status overlay after connecting, and has no DevTools console errors.
