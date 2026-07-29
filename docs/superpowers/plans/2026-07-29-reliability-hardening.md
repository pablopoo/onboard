# Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the complete reliability, security, client correctness, release, and maintenance backlog in the approved hardening design without adding product functionality.

**Architecture:** Preserve the single Go binary, in-memory Hub, WebSocket event relay, shared browser state, and Canvas renderer. Tighten those boundaries with a ready handshake, bounded canonical state, a per-process presenter capability, bounded connection lifetime, deterministic pointer ownership, and reproducible release tooling.

**Tech Stack:** Go 1.26.5, `github.com/coder/websocket`, plain ECMAScript modules on Node 24.18.0/npm 11.16.0, Canvas 2D, Bash.

## Global Constraints

- No accounts, cloud service, database, persistence, framework, build system, or new runtime dependency.
- Preserve the happy path: start the binary, open Board, open Viewer, draw.
- Keep all presenter controls and presenter capability data out of Viewer.
- Use the exact numeric limits from `docs/superpowers/specs/2026-07-29-reliability-hardening-design.md`.
- For every behavior change: add one focused test, run it and observe the expected failure, implement the minimum change, then run the complete affected suite.
- Do not weaken existing background, queue, undo, Viewer-only, or presenter-conflict behavior.

---

### Task 1: Bound the browser protocol and board state

**Files:**
- Modify: `web/core/protocol.js`
- Modify: `web/core/board-state.js`
- Modify: `web/board/board.js`
- Test: `web/core/protocol.test.mjs`
- Test: `web/core/board-state.test.mjs`
- Test: `web/board/board.test.mjs`

**Interfaces:**
- Produces: exported `RELAY_LIMITS` and `utf8ByteLength(value)` from `protocol.js`.
- Preserves: `validateBoardEvent(event)` and `applyBoardEvent(state, event)` signatures.
- Adds: `eventSessionId` option to `createBoardController` for deterministic ID tests.

- [ ] **Step 1: Write failing protocol boundary tests**

Add literal cases for 129-byte event/stroke IDs, 65-byte board IDs/colors, SVG image data URLs, and expiry 60,001 ms beyond `event.at`:

```js
test("relay identifiers are bounded by UTF-8 bytes", () => {
  const event = makeEvent("pointer:hide", {});
  event.id = "é".repeat(65);
  assert.equal(validateBoardEvent(event).valid, false);
});

test("background accepts only normalized JPEG data", () => {
  const event = makeEvent("board:set-background", {
    background: { kind: "image", dataUrl: "data:image/svg+xml,<svg/>", width: 1, height: 1 },
  });
  assert.equal(validateBoardEvent(event).valid, false);
});
```

- [ ] **Step 2: Run the focused protocol tests and verify RED**

Run: `node --test --test-name-pattern="bounded|JPEG|expiry" web/core/protocol.test.mjs`

Expected: FAIL because current validation accepts arbitrary non-empty strings, any `data:image/` subtype, and any finite expiry.

- [ ] **Step 3: Add exact protocol limits**

Export:

```js
export const RELAY_LIMITS = Object.freeze({
  eventIdBytes: 128,
  boardIdBytes: 64,
  strokeIdBytes: 128,
  colorBytes: 64,
  maxStrokes: 4_096,
  maxPointsPerStroke: 8_192,
  maxTotalPoints: 65_536,
  maxStateBytes: 7_500_000,
  maxEphemeralLifetimeMs: 60_000,
});
```

Use `new TextEncoder().encode(value).byteLength`, require `data:image/jpeg;base64,`, and validate expiry against the parent event timestamp.

- [ ] **Step 4: Write failing state-invariant tests**

Test that a duplicate completed stroke ID, 4,097th stroke, 8,193rd point on one stroke, 65,537th total point, and 7,500,001st retained byte leave state unchanged. Test restore rejects duplicate IDs and rebuilds correct counters.

```js
test("duplicate stroke IDs do not append or widen undo", () => {
  const state = createBoardState();
  applyBoardEvent(state, strokeStart("evt-1", "stroke-1"));
  applyBoardEvent(state, strokeEnd("evt-2", "stroke-1"));
  applyBoardEvent(state, strokeStart("evt-3", "stroke-1"));
  assert.equal(state.strokes.length, 1);
});
```

- [ ] **Step 5: Run state tests and verify RED**

Run: `node --test --test-name-pattern="duplicate|budget|retained" web/core/board-state.test.mjs`

Expected: duplicate starts append and at least one over-budget mutation succeeds.

- [ ] **Step 6: Add incremental state accounting**

Keep internal `strokeIds`, `strokeBytes`, `totalPoints`, and `retainedBytes`. A restore calculates counters once. Start/point measure only their new retained data. Undo/expire/clear subtract or reset counters. `snapshotBoardState` must omit internal accounting.

- [ ] **Step 7: Write and fail the reload-safe stroke-ID test**

Create two controllers with sessions `session-a` and `session-b`; the first generated IDs must be `stroke_session-a_000001` and `stroke_session-b_000001`.

Run: `node --test --test-name-pattern="stroke IDs include" web/board/board.test.mjs`

Expected: FAIL because current IDs are process-global `stroke_000001` values.

- [ ] **Step 8: Make stroke numbering controller-local**

Move `nextStrokeNumber` into the controller and generate `stroke_${eventSessionId}_${counter}`. Remove the module-global stroke counter. Keep reducer duplicate rejection as defense against direct clients.

- [ ] **Step 9: Run all browser state suites and commit**

```bash
node --test web/core/protocol.test.mjs web/core/board-state.test.mjs web/board/board.test.mjs
git add web/core/protocol.js web/core/protocol.test.mjs web/core/board-state.js web/core/board-state.test.mjs web/board/board.js web/board/board.test.mjs
git commit -m "fix: enforce browser relay state invariants"
```

### Task 2: Bound Go parsing and materialize snapshots only on demand

**Files:**
- Modify: `internal/hub/hub.go`
- Modify: `internal/hub/hub_test.go`
- Modify: `internal/hub/hub_internal_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_test.go`

**Interfaces:**
- Changes: `func (h *Hub) Record(event Event) bool` reports accepted mutation.
- Produces: `Snapshot` and subscription-time restore creation from canonical state.
- Removes: stored full restore rebuild from the `Record` hot path.

- [ ] **Step 1: Write failing parser limit tests**

Add table cases mirroring Task 1. Use hand-built JSON and assert `parseRelayEvent` returns false for each first-over-limit value.

```go
func TestParseRelayEventRejectsOversizedEventID(t *testing.T) {
  event := validRelayEventMap()
  event["id"] = strings.Repeat("x", 129)
  data, _ := json.Marshal(event)
  if _, ok := parseRelayEvent(data); ok {
    t.Fatal("accepted a 129-byte event ID")
  }
}
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `/usr/local/go/bin/go test ./internal/server -run 'TestParseRelayEventRejects|TestValidateRelay.*Limit' -count=1`

- [ ] **Step 3: Implement matching Go limits**

Bound UTF-8 byte lengths, JPEG prefix, expiry horizon, restore counts, duplicate stroke IDs, and serialized restore size before returning an event.

- [ ] **Step 4: Write failing Hub state tests**

Cover duplicate completed IDs, per-stroke/total points, total state bytes, clear/reset, restore accounting, and accepted-state snapshots. Change call sites in tests to expect the new boolean return.

```go
if !relay.Record(strokeStart("evt-1", "stroke-1")) { t.Fatal("first start rejected") }
relay.Record(strokeEnd("evt-2", "stroke-1"))
if relay.Record(strokeStart("evt-3", "stroke-1")) { t.Fatal("duplicate accepted") }
```

- [ ] **Step 5: Run Hub tests and verify RED**

Run: `/usr/local/go/bin/go test ./internal/hub -run 'TestRecordRejects|TestSnapshot' -count=1`

- [ ] **Step 6: Replace stored restore events with canonical state**

Replace `events []Event` with `lastEvent Event` and `hasState bool`. `Record` applies and broadcasts only the delta. `Snapshot` and `SubscribeWithSnapshotRole` call:

```go
func (h *Hub) snapshotLocked() []Event {
  if !h.hasState { return nil }
  return []Event{h.state.RestoreEvent(h.lastEvent)}
}
```

Track stroke IDs, point counts, per-stroke bytes, and aggregate bytes in `boardSnapshot`. Recalculate once for restore and update deltas for other events.

- [ ] **Step 7: Add a non-gating scaling benchmark**

Benchmark `Record(stroke:point)` with 100, 1,000, and 10,000 retained points. Report allocations and ns/op; do not assert timing. The code review gate is that `Record` contains no call to `RestoreEvent` or full state clone.

- [ ] **Step 8: Run Go suites and commit**

```bash
/usr/local/go/bin/go test ./internal/hub ./internal/server -count=1
git add internal/hub/hub.go internal/hub/hub_test.go internal/hub/hub_internal_test.go internal/server/server.go internal/server/server_test.go
git commit -m "fix: bound relay state and build snapshots on demand"
```

### Task 3: Add relay-ready ordering, initial retry, and Board rebase

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_test.go`
- Modify: `web/transports/websocket-relay-transport.js`
- Modify: `web/transports/websocket-relay-transport.test.mjs`
- Modify: `web/board/board.js`
- Modify: `web/board/board.test.mjs`
- Modify: `web/viewer/viewer.test.mjs`

**Interfaces:**
- Adds: `system:relay-ready` after zero or one snapshot frames.
- Changes: transport resolves `connect()` and emits `connected` only after ready.
- Adds: Board reapplication of queued local events after an authoritative restore.

- [ ] **Step 1: Write failing server frame-order tests**

With an empty hub, assert the first frame is `system:relay-ready`. With populated state, assert `board:restore` then ready. Live presence/deltas must come afterward.

- [ ] **Step 2: Run server test and verify RED**

Run: `/usr/local/go/bin/go test ./internal/server -run 'TestRelay.*Ready' -count=1`

- [ ] **Step 3: Send ready after the snapshot loop**

Call `writeRelaySystemEvent` before starting the live writer goroutine. Keep the marker payload empty and do not store/broadcast it through Hub.

- [ ] **Step 4: Write failing transport readiness tests**

Open the fake socket and assert the connect promise remains pending and status remains connecting. Deliver a snapshot and assert it reaches handlers. Deliver ready and assert connected, queued send flush, promise resolution, and no ready event reaches handlers. Add initial open failure retry and open-without-ready timeout cases.

- [ ] **Step 5: Run transport tests and verify RED**

Run: `node --test --test-name-pattern="ready|initial failure|ready timeout" web/transports/websocket-relay-transport.test.mjs`

- [ ] **Step 6: Implement pre-ready socket state**

Attach message handlers on socket open, start a five-second ready timer, and queue sends while started/not closed. Consume ready internally; only then set `hasOpened`, flush, emit connected, and resolve. Initial error/close enters the existing reconnect scheduler.

- [ ] **Step 7: Write the split-brain Board regression**

Queue one local stroke before connection, deliver an older restore, then ready. Assert Board still contains the local stroke and its start/point/end events are sent once with unchanged IDs.

- [ ] **Step 8: Rebase queued events after restore**

When a restore arrives before open, apply it, then apply `queuedEvents[].event` in original order locally. Do not send during rebase; connected status remains the only flush trigger.

- [ ] **Step 9: Run all affected suites and commit**

```bash
/usr/local/go/bin/go test ./internal/server -count=1
node --test web/transports/websocket-relay-transport.test.mjs web/board/board.test.mjs web/viewer/viewer.test.mjs
git add internal/server/server.go internal/server/server_test.go web/transports/websocket-relay-transport.js web/transports/websocket-relay-transport.test.mjs web/board/board.js web/board/board.test.mjs web/viewer/viewer.test.mjs
git commit -m "fix: synchronize relay state before connected"
```

### Task 4: Authorize presenter access without accounts

**Files:**
- Modify: `cmd/onboard/main.go`
- Modify: `cmd/onboard/main_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_test.go`
- Modify: `web/home/home.js`
- Modify: `web/home/home.test.mjs`
- Modify: `web/board/board.js`
- Modify: `web/board/board.test.mjs`

**Interfaces:**
- Adds: `server.Config.PresenterCapability string`.
- Adds: 256-bit base64url capability in startup Board URL fragment.
- Adds: `onboard.presenterCapability` local-storage key.
- Adds: `system:presenter-unauthorized`; preserves `system:presenter-conflict`.

- [ ] **Step 1: Write failing capability/startup URL tests**

Inject 32 literal bytes and assert exact raw-base64url output without padding. Board startup URLs contain `#presenter=<token>`; Viewer and `/api/share` never contain the token.

- [ ] **Step 2: Run and verify RED**

Run: `/usr/local/go/bin/go test ./cmd/onboard -run 'TestPresenterCapability|TestWriteStartupURLs' -count=1`

- [ ] **Step 3: Generate the process capability securely**

Use `crypto/rand.Reader` and `base64.RawURLEncoding`. Abort startup on random-read failure. Pass the token into server config and print it only in Board fragments.

- [ ] **Step 4: Write failing endpoint authorization tests**

Use real WebSockets for missing, wrong, correct, and correct-but-conflicting tokens. Missing/wrong receives unauthorized and cannot mutate Hub. Correct first presenter mutates; correct second receives conflict.

- [ ] **Step 5: Implement constant-time validation**

Compare equal-length byte slices with `subtle.ConstantTimeCompare` before presenter acquisition. Accept the socket only to deliver the explicit unauthorized system event, then policy-close it.

- [ ] **Step 6: Write failing browser fragment/storage tests**

Assert a valid 43-character base64url fragment is stored, removed from displayed URL with `history.replaceState`, applied only to the Board link and Board WebSocket query, and omitted from Viewer links.

- [ ] **Step 7: Implement browser propagation and statuses**

Home and Board load fragment then storage. Board adds `presenter` to the relay URL. Unauthorized locks controls with `Presenter link required`; conflict keeps `Presenter active elsewhere`.

- [ ] **Step 8: Add tested browser security headers**

Wrap responses with `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. Test response behavior on `/`, `/board`, and `/viewer`.

- [ ] **Step 9: Run suites and commit**

```bash
/usr/local/go/bin/go test ./cmd/onboard ./internal/server -count=1
node --test web/home/home.test.mjs web/board/board.test.mjs
git add cmd/onboard/main.go cmd/onboard/main_test.go internal/server/server.go internal/server/server_test.go web/home/home.js web/home/home.test.mjs web/board/board.js web/board/board.test.mjs
git commit -m "fix: authorize the local presenter capability"
```

### Task 5: Bound presenter and connection lifetime

**Files:**
- Modify: `internal/hub/hub.go`
- Modify: `internal/hub/hub_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_test.go`
- Modify: `cmd/onboard/main.go`
- Modify: `cmd/onboard/main_test.go`

**Interfaces:**
- Changes: `AcquirePresenter(owner string) bool`, `ReleasePresenter(owner string) bool`.
- Adds: internal global/per-source `connectionGate`.
- Adds: `server.HTTPServer(handler) *http.Server` with tested timeout values.

- [ ] **Step 1: Write and fail owner-safe release tests**

Acquire `owner-a`, prove `owner-b` cannot release/acquire it, then release with `owner-a` and acquire with `owner-b`.

- [ ] **Step 2: Replace the boolean with owner identity**

Store `presenterOwner string`. Reject empty or occupied acquisition. Release only an exact current owner and return whether state changed.

- [ ] **Step 3: Write failing heartbeat integration test**

Use injectable 10ms ping/20ms timeout values in the test endpoint. Connect a client that does not answer control frames; assert its handler exits and a replacement presenter connects. Also retain the graceful-close regression.

- [ ] **Step 4: Serialize writes and heartbeat**

The writer goroutine selects between relay events and a 15-second ticker. Ping with a five-second context; failure calls `CloseNow`, causing reader exit and matching owner release.

- [ ] **Step 5: Write failing admission tests**

Acquire 64 connections for one IP and reject the 65th. Fill the 128 global slots across IPs and reject the next. Release all and assert both counters are zero. Endpoint overflow returns HTTP 503 before upgrade.

- [ ] **Step 6: Implement idempotent connection admission**

Parse remote host IP, count global and per-source slots, and return one `sync.Once`-protected release closure. Acquire before `websocket.Accept`; defer release on every accepted path.

- [ ] **Step 7: Write failing HTTP server configuration test**

Assert `ReadHeaderTimeout == 5*time.Second`, `IdleTimeout == 60*time.Second`, and `MaxHeaderBytes == 16<<10`. Make main use the tested constructor.

- [ ] **Step 8: Run race suites and commit**

```bash
/usr/local/go/bin/go test ./internal/hub ./internal/server ./cmd/onboard -count=1
/usr/local/go/bin/go test -race ./internal/hub ./internal/server -count=1
git add internal/hub/hub.go internal/hub/hub_test.go internal/server/server.go internal/server/server_test.go cmd/onboard/main.go cmd/onboard/main_test.go
git commit -m "fix: bound relay connections and presenter liveness"
```

### Task 6: Correct pointer ownership, DPR, and collapsed focus

**Files:**
- Modify: `web/board/board.js`
- Modify: `web/board/board.test.mjs`
- Modify: `web/core/canvas-renderer.js`
- Modify: `web/core/canvas-renderer.test.mjs`
- Modify: `web/viewer/viewer.js`
- Modify: `web/viewer/viewer.test.mjs`

**Interfaces:**
- Adds: one idempotent owned-pointer cleanup path.
- Adds: `options.pixelRatio` to `renderBoardState`, default 1.
- Adds: toolbar `inert`, `aria-hidden`, and focus return without visual redesign.

- [ ] **Step 1: Write failing multi-pointer tests**

Start pointer 1, exercise pointer 2 down/move/up, finish pointer 1, and assert one stroke lifecycle containing only pointer 1 samples. Add pointer mode and `lostpointercapture` cases.

- [ ] **Step 2: Run RED and enforce first-pointer ownership**

Run: `node --test --test-name-pattern="second pointer|palm|lost pointer" web/board/board.test.mjs`

Ignore secondary pointer-down before capture. Register `lostpointercapture`. A non-owner event must never clear active state.

- [ ] **Step 3: Write failing DPR tests**

Render marker, eraser, chalk, and pointer at ratios 1 and 2. Assert physical line widths/radii at ratio 2 are exactly double, while normalized point positions remain proportional to the backing viewport.

- [ ] **Step 4: Run RED and scale visual dimensions**

Run: `node --test --test-name-pattern="pixel ratio|DPR" web/core/canvas-renderer.test.mjs`

Multiply tool widths, chalk particle/dust dimensions, and pointer size at draw time. Board/Viewer pass `canvas.width / rect.width`, falling back to 1.

- [ ] **Step 5: Write failing toolbar accessibility tests**

On compact collapse, assert `toolbar.inert === true`, `aria-hidden === "true"`, and focus moves from a toolbar control to the compact toggle. Expansion reverses inert/aria-hidden.

- [ ] **Step 6: Implement and run complete browser suites**

```bash
node --test web/board/board.test.mjs web/core/canvas-renderer.test.mjs web/viewer/viewer.test.mjs
git add web/board/board.js web/board/board.test.mjs web/core/canvas-renderer.js web/core/canvas-renderer.test.mjs web/viewer/viewer.js web/viewer/viewer.test.mjs
git commit -m "fix: harden board input rendering and focus"
```

### Task 7: Rank LAN addresses and embed production assets only

**Files:**
- Modify: `cmd/onboard/main.go`
- Modify: `cmd/onboard/main_test.go`
- Modify: `web/assets.go`
- Create: `web/assets_test.go`

**Interfaces:**
- Makes `selectLANIPv4Addresses` deterministic and tunnel-aware.
- Preserves `web.Assets embed.FS` while excluding Go/test sources.

- [ ] **Step 1: Write failing LAN ranking tests**

Shuffle candidates named `wlan0`, `en0`, `eth0`, `tailscale0`, `wg0`, `tun0`, `utun4`, `docker0`, and unknown interfaces. Expected order is private physical Wi-Fi/Ethernet, unknown usable, then one virtual fallback only when no preferred address exists.

- [ ] **Step 2: Run RED and implement deterministic scoring**

Run: `/usr/local/go/bin/go test ./cmd/onboard -run 'TestSelectLANIPv4Addresses.*Rank' -count=1`

Add physical/tunnel/virtual classification. Sort by score, interface name, then four-byte IP; keep existing result limits.

- [ ] **Step 3: Write failing embedded filesystem test**

Walk `web.Assets`; assert required production files exist and no path ends in `.go` or `.test.mjs`.

- [ ] **Step 4: Run RED and narrow embed patterns**

Run: `/usr/local/go/bin/go test ./web -run TestEmbeddedAssetsContainOnlyProductionFiles -count=1`

Replace `//go:embed *` with explicit HTML, CSS, webmanifest, icon, and production `*.js` patterns. Do not match `.mjs`.

- [ ] **Step 5: Run and commit**

```bash
/usr/local/go/bin/go test ./cmd/onboard ./web ./internal/server -count=1
git add cmd/onboard/main.go cmd/onboard/main_test.go web/assets.go web/assets_test.go
git commit -m "fix: select useful LAN links and production assets"
```

### Task 8: Make releases reproducible and non-destructive

**Files:**
- Modify: `scripts/build-release.sh`
- Modify: `tests/build-release-test.sh`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `docs/release.md`

**Interfaces:**
- Adds: `DIST_DIR`, default `dist`.
- Outputs: six binaries, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and checksums.

- [ ] **Step 1: Write failing release behavior tests**

Seed `dist/keep-me`, run the shell test with temporary output, and assert the seed remains. Capture Go stub arguments and require `-trimpath` plus `-ldflags=-s -w`. Require notices in checksum entries.

- [ ] **Step 2: Run and verify RED**

Run: `bash tests/build-release-test.sh`

Expected: current cleanup deletes seeded release files and build arguments lack reproducibility flags.

- [ ] **Step 3: Parameterize output and flags**

Route all outputs through `dist_dir="${DIST_DIR:-dist}"` and build with:

```bash
"$GO_BIN" build -trimpath -ldflags='-s -w' -o "$output" ./cmd/onboard
```

Copy notices before generating explicit checksum entries.

- [ ] **Step 4: Add dependency notice and two-path reproducibility test**

Include the exact ISC notice for `github.com/coder/websocket v1.8.14`. Build Linux/amd64 from two temporary absolute checkout paths using the same revision/toolchain and compare SHA-256 hashes.

- [ ] **Step 5: Run release verification and commit**

```bash
bash tests/build-release-test.sh
release_dir="$(mktemp -d)"
GOCACHE=/tmp/onboard-go-build-cache DIST_DIR="$release_dir" scripts/build-release.sh
(cd "$release_dir" && sha256sum -c checksums.txt)
git add scripts/build-release.sh tests/build-release-test.sh THIRD_PARTY_NOTICES.md docs/release.md
git commit -m "build: make release artifacts reproducible and safe"
```

### Task 9: Verify and safely replace the Go toolchain

**Files:**
- Modify: `scripts/install-go-latest.sh`
- Modify: `tests/install-go-latest-test.sh`

**Interfaces:**
- Preserves Linux `/usr/local/go` target.
- Adds official archive checksum, staging validation, backup, and rollback.

- [ ] **Step 1: Add failing installer fixtures**

Cover malformed checksum, mismatched tarball, invalid staged `go/bin/go`, failed final move, and success. Every failure seeds an old installation marker and asserts it survives.

- [ ] **Step 2: Run and verify RED**

Run: `bash tests/install-go-latest-test.sh`

- [ ] **Step 3: Verify before privileged mutation**

Fetch `${archive}.sha256`, require one 64-character lowercase digest, verify with `sha256sum` or `shasum -a 256`, extract in temporary staging, and require the staged binary to report the expected version.

- [ ] **Step 4: Implement backup/swap rollback**

Move the existing installation to a unique backup, move the validated staging directory into place, and restore the backup from a trap unless the new binary passes its final version check. Remove backup only after success.

- [ ] **Step 5: Run and commit**

```bash
bash -n scripts/install-go-latest.sh tests/install-go-latest-test.sh
bash tests/install-go-latest-test.sh
git add scripts/install-go-latest.sh tests/install-go-latest-test.sh
git commit -m "build: verify and safely replace Go"
```

### Task 10: Update toolchain pins and security gates

**Files:**
- Modify: `go.mod`
- Modify: `.node-version`
- Modify: `.nvmrc`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/security.md`
- Modify: `docs/release.md`

**Interfaces:**
- Pins: Go 1.26.5, Node 24.18.0, npm 11.16.0.
- Adds: documented `govulncheck ./...` release gate.

- [ ] **Step 1: Update manifests as one unit**

Change `toolchain go1.26.5`, both Node files, package manager, and engines. Regenerate lock metadata with lifecycle scripts disabled and no package additions.

- [ ] **Step 2: Verify exact tool/manifests**

```bash
node --version
npm --version
/usr/local/go/bin/go version
/usr/local/go/bin/go mod tidy -diff
/usr/local/go/bin/go mod verify
npm ci --ignore-scripts --dry-run
```

If the local tool is older, use Task 9's verified installer or report the exact mismatch; do not lower the pins.

- [ ] **Step 3: Add and run vulnerability gates**

Document missing `govulncheck` as a release blocker with its official install command. Run:

```bash
npm run security:npm
govulncheck ./...
```

- [ ] **Step 4: Commit toolchain maintenance**

```bash
git add go.mod .node-version .nvmrc package.json package-lock.json docs/security.md docs/release.md
git commit -m "build: update supported security toolchains"
```

### Task 11: Synchronize documentation and browser smoke coverage

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/how-it-works.md`
- Modify: `docs/local-browser-smoke.md`
- Modify: `docs/project-objective.md`
- Modify: `docs/release.md`
- Modify: `README.md`
- Modify: `tests/local-browser-smoke.sh`

**Interfaces:**
- Documents ready ordering, bounded state, capability fragment, heartbeat, snapshot-on-join, Viewer fullscreen control, resolved in-memory persistence, and release outputs.
- Extends the current smoke harness; adds no browser dependency.

- [ ] **Step 1: Add smoke regressions**

Add cases for connected-only-after-ready, queued stroke rebase, wrong/correct/conflicting presenter capability, heartbeat replacement using shortened test values, phone second-pointer ownership, DPR 1/2 apparent width tolerance, collapsed toolbar focus exclusion, and Viewer-only controls/fullscreen.

- [ ] **Step 2: Prove each new smoke assertion can fail**

Run `timeout 240s tests/local-browser-smoke.sh`. If an earlier implementation already makes a case green, temporarily revert only its production hunk, observe that case fail, then restore the hunk.

- [ ] **Step 3: Correct documentation drift**

Remove event-log, unresolved-persistence, and button-free-Viewer claims. Document Board capability as a local secret rather than an account. Keep Viewer URLs secret-free. Update release artifacts and commands.

- [ ] **Step 4: Run smoke and commit**

```bash
timeout 240s tests/local-browser-smoke.sh
git add docs/architecture.md docs/how-it-works.md docs/local-browser-smoke.md docs/project-objective.md docs/release.md README.md tests/local-browser-smoke.sh
git commit -m "docs: synchronize hardened runtime behavior"
```

### Task 12: Full verification and requirement audit

**Files:**
- Review: every file changed by Tasks 1-11
- Review: `docs/superpowers/specs/2026-07-29-reliability-hardening-design.md`

**Interfaces:**
- Produces no new behavior; this is the completion gate.

- [ ] **Step 1: Run the complete automated matrix**

```bash
npm run test:js
npm run security:npm
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go test ./...
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go test -race ./...
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go vet ./...
/usr/local/go/bin/go mod verify
/usr/local/go/bin/go mod tidy -diff
bash tests/install-go-latest-test.sh
bash tests/build-release-test.sh
timeout 240s tests/local-browser-smoke.sh
git diff --check
```

- [ ] **Step 2: Build and inspect all releases**

Build into a new temporary `DIST_DIR`; validate all six executable formats, the two notice files, and `sha256sum -c checksums.txt`.

- [ ] **Step 3: Audit every approved invariant**

Confirm: ready precedes connected; queued events survive restore; IDs are unique/bounded; state and connections are bounded; presenter authorization and heartbeat work; Viewer has no controls/capability; pointer/DPR/focus regressions pass; release/installer preservation is proven; docs match runtime.

- [ ] **Step 4: Audit scope and commits**

Run `git status --short`, `git log --oneline --decorate -20`, and inspect each task diff. Confirm no account, cloud service, persistence, framework, or runtime dependency was introduced. Worktree must be clean before completion is claimed.

