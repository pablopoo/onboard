# Security

Onboard keeps the dependency surface intentionally small. The Go server is the
runtime path and the browser code is plain JavaScript served from the embedded
binary. Node is used for JavaScript tests, not for production serving.

## Dependency Locking

- Go dependencies must stay pinned in `go.mod` and verified by `go.sum`.
- The Go toolchain version is recorded in `go.mod`.
- npm must keep `package-lock.json` committed, even when there are no external
  packages. The lockfile makes future dependency additions explicit in review.
- `package.json` pins the expected Node and npm versions for this project.
- `.nvmrc` and `.node-version` mirror the Node version for common local version
  managers.

## npm Install Policy

The project `.npmrc` sets conservative defaults:

- `save-exact=true` avoids loose semver ranges for new packages.
- `package-lock=true` requires lockfile updates.
- `ignore-scripts=true` blocks dependency lifecycle scripts by default.
- `audit=true` keeps npm audit enabled.

If a future dependency legitimately needs install scripts, review that package
first, document the reason in the pull request or commit, and run the install
with an explicit override:

```bash
npm install --ignore-scripts=false <package>
```

Do not keep that override in `.npmrc`.

## Review Checklist For New Dependencies

Before adding a dependency:

- Prefer standard library, existing code, or a tiny local helper when practical.
- Check package name, publisher, repository, and recent publish history.
- Avoid newly published versions during active npm supply-chain incidents.
- Commit the changed manifest and lockfile together.
- Run:

```bash
npm run security:npm
npm run test:js
GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go test ./...
```

For suspected malicious package exposure, isolate the machine before rotating
tokens if persistence is possible. Then remove persistence, clear poisoned
caches, and rotate GitHub, npm, cloud, SSH, and CI/CD credentials that were
available to the affected environment.
