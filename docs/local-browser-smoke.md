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

- `/board` loads without browser console or page errors.
- `/board` has a visible canvas, presenter toolbar, and the expected presenter controls.
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
2. Open the printed Board URL and confirm the canvas and presenter controls are visible with no DevTools console errors.
3. Open the printed Viewer URL and confirm it shows only viewer output markup, with no buttons, selects, inputs, toolbar, or persistent status overlay after connecting, and has no DevTools console errors.
