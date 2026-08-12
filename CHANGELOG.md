# Changelog

All notable changes to this package are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-08-12

Rebuilt on a Mixpanel-derived core (see `NOTICE`). The surface is now
data in, decisions out: no admin or console operations.

### Security

- **Removed `tests/intempt.spec.ts`, which contained a live staging API key
  and was published to npm.** `.npmignore` listed `test` while the directory
  was `tests`, and it also excluded `dist/` — the directory `main` points at.
  Replaced with a `files` allowlist plus a CI check that fails the build if
  anything outside `dist/` and the docs enters the tarball.
  The exposed key has since been revoked. It remains in this repository's git
  history and in the published 1.0.1 tarball, which is why revocation rather
  than removal was the fix.
- API keys now travel in an `Authorization: Basic` header instead of an
  `?apiKey=` query parameter. The server accepts both, but logs
  "API key received via query parameter — this is deprecated and insecure"
  for every query-parameter request.
- Errors no longer dump the request object, which carried the key in its URL.
  `ApiKeyCredentials` masks the secret in `toString`, `util.inspect` and
  `JSON.stringify`.

### Fixed

- **Unbounded event resend.** With no batching configured — the documented
  default — every call resent the entire in-memory buffer, because the
  immediate path never cleared it. N events produced N(N+1)/2 records.
- **Silent event loss.** There was no `flush()` or `close()`. Events buffered
  below the `maxSize` threshold were never sent. Both now exist, plus an
  optional `beforeExit` flush.
- **Events dropped mid-flush.** The buffer was cleared after an awaited send,
  discarding anything appended during the request. The batcher now removes only
  the slice it actually sent.
- **`NODE_ENV=test` retargeted staging.** Any consumer running their own test
  suite shipped data to `api.staging.intempt.com`. Host is now configuration.
- **`optOut()` only gated tracking.** Consent records, experiment lookups and
  feed reads all kept sending. It now suppresses every write path. Read-side
  `decide` calls are intentionally unaffected.
- **Consent timestamps were discarded by the server.** The API compares
  `timestamp * 1000` against millisecond bounds, so the field is epoch
  _seconds_; the SDK sent milliseconds, so the server always substituted its
  own receive time. Now sent in seconds, with client-side range validation.
- **`profileId` was required where the API does not require it.** The server
  accepts any one of `userId`, `profileId` or `accountId` and copies `userId`
  into `profileId`. Consent additionally accepts `masterId`.
- Errors carry the HTTP status, response body and `Retry-After` instead of a
  generic `Failed to send request`.

### Added

- `Intempt.init({ org, project, apiKey, sourceId?, ... })` replaces the
  positional constructor.
- Configuration: `host`, `protocol`, `path`, `timeout`, `keepAlive`, `logger`,
  `debug`, `batch`, `maxRequestEvents`, plus `setConfig()`.
- Keep-alive HTTP agents and `HTTPS_PROXY` / `HTTP_PROXY` support.
- `trackBatch()`, chunked at `maxRequestEvents` (default 50) so one call cannot
  become one oversized request.
- Optional buffering via `batch`, with a documented retry policy: 413 halves
  the batch, 429 honours `Retry-After`, 5xx and timeouts back off
  exponentially, other 4xx drop the batch, and five consecutive failures stop
  the batcher rather than looping.
- `flush()`, `close()`, `buffered`, `isOptedIn()`.
- `timestamp` on `track()`, accepting a `Date` or epoch milliseconds.
  Note: whether the event store honours a client-supplied timestamp or stamps
  ingest time is **unverified**; do not treat this as a backfill guarantee yet.
- `X-Intempt-Lib: intempt-node/<version>` on every request. Nothing is added to
  the event payload: a new payload field could affect a downstream event schema,
  and a header cannot.
- Every internal is a true `#private` field, so no part of the object graph
  reaches the transport, the credential, or a namespace's dependencies.
- `maxConcurrentRequests` (default 1) to overlap the chunks of one
  `trackBatch()` call. Bounded parallelism via a shared cursor; a failure rejects
  only after every sibling request has settled.
- `agent` to supply your own `https.Agent` for mutual TLS, a private CA, or an
  explicit proxy policy. When set it is used verbatim, the SDK creates none of its
  own, and `close()` does not destroy it.
- **A request always settles.** A `close` guard rejects if a request ends without
  emitting either a response or an error, so a caller can never be left awaiting a
  promise that resolves nowhere. Real dead-socket cases — destroyed before the
  response, destroyed mid-body, closed with zero bytes — are covered over an actual
  socket in the integration suite.
- **A logger that throws cannot fail a request.** The caller's logger is wrapped,
  so an unrelated bug in someone's logging setup no longer loses an event.
- Whitespace-only identifiers are rejected. `userId: '   '` is truthy in
  JavaScript and would have keyed a profile on a blank string.
- `IntemptApiError` with `status`, `body`, `retryAfterMs` and `retryable`.
- 232 tests with an 80% coverage gate, in five layers: `nock` unit tests, a
  real-socket integration suite on loopback, a consumer-install check that packs
  the tarball and runs a sample app against it, an adversarial suite written to
  break the SDK rather than confirm it, and an opt-in contract test against a real
  project.
- `examples/basic`, a runnable sample app covering every method. It installs the
  packed tarball rather than the source tree, and typechecks against the shipped
  `.d.ts` under `exactOptionalPropertyTypes` with `skipLibCheck` off — stricter
  than the library's own build. Offline against a bundled mock by default; give it
  credentials and project object ids and it runs against the real API, which is
  the only configuration that exercises the published artifact over the network.
- `npm run verify:consumer` and `npm run test:e2e`.
- **Snowflake IDs are no longer coerced through `Number()`.** `consent` sent
  `sourceId` and `masterId` as JS numbers. A real source id such as
  `1841503112918048768` is 19 digits, past `Number.MAX_SAFE_INTEGER`, so it was
  silently rounded to `1841503112918048800` — a different source. Both fields are
  declared server-side with `LongFromStringDeserializer`, so a string is the
  correct and intended representation. Regression-tested with the real 19-digit
  id in the unit, integration and contract suites.
- **The public identifier surface is `userId` and `accountId` only.** 1.x took
  `profileId` on every call and consent additionally took `masterId`. Both are
  platform-internal: `profileId` is minted by the browser SDK on the device, and
  `masterId` is assigned after identity resolution with no way to look one up
  from a server. A server supplying either produces an orphan profile or breaks
  on merge. Verified against the live API that `userId` alone is accepted by
  `/track` (201), `/consents/data` (200) and `/optimization/choose-api` (200) —
  the platform sets `profileId = userId` itself. `profileId` remains reachable
  through the deprecated 1.x `SDK` shim, whose callers' data is already keyed
  that way, but it is typed out of the public options.
- `exports` now includes `./package.json`. Without it,
  `require('intempt/package.json')` was a hard error, which breaks bundlers and
  version-reporting tools. Found by the consumer-install check; the unit suite
  could not see it, because it imports from `src/`.
- CI on pull requests across Node 20, 22 and 24, gated on `prettier --check`,
  `oxlint`, `tsc --noEmit`, coverage, build, and a tarball-contents check.
- Publishing moved to version tags with npm provenance, and GitHub Release notes
  are generated from the commit log by `.github/scripts/generate-changelog.sh`.
- `.npmrc` sets `min-release-age=7`, so a freshly published (possibly
  compromised) dependency version cannot enter `npm ci`, and `yes=false` so `npx`
  cannot silently fetch packages.
- GitHub Actions pinned by commit digest rather than a mutable tag.
- `SECURITY.md` with a disclosure address and API-key handling guidance, plus
  `CODEOWNERS`.

### Changed

- `axios` replaced by `node:https` plus `https-proxy-agent`. One runtime
  dependency, matching mixpanel-node's approach.
- Node 20 or newer is required. Node 18 reached end of life in April 2025.
- Invalid arguments now reject. Previously most methods logged a warning and
  resolved, and the product helpers returned `{ error: true }`.
- Commerce helpers moved to `ecommerce.*`. The wire format is unchanged,
  including the shared `eventId` across order lines.

### Deprecated

- `new SDK(...)` still works and forwards to the new client, with a one-time
  warning. It will be removed in 3.0.0. Migrate with `sdk.v2`.

### Removed

- `trackingClient`, `consentsClient`, `optimizationClient` and
  `recommendationClient` properties. They were never documented but were
  reachable, so this is breaking.

### Known gaps

- Content and design generation (`image/generate`, `draft-message/generate`,
  `reply/generate`, `preflight/email`, user and account summaries) is absent.
  Those endpoints authenticate with a bearer JWT carrying a `person_id` claim;
  there is no API-key path into them. Unblocking that is a change in
  llm-wrapper, not here.
- The per-request event ceiling is a client-side default of 50. The server does
  not publish one and has no 413 handling, so measure the real limit before
  relying on it; 413 responses halve the batch at runtime in the meantime.
- Identity merge (`/users/merge`, `/accounts/merge`) is deliberately not
  exposed. It is irreversible, has no inverse endpoint, and takes internal
  numeric IDs that this SDK has no way to resolve. Use `alias()`.
- `recommend()` returning an empty `products` array is normal: it means the user
  has no recommendations right now. A feed id that does not exist in the project
  answers `400 "Name is null"`, so a 200 is itself the proof that the feed
  resolved. The contract test asserts both, the second as a negative control.

## [1.0.1] — 2024-11-13

Last release of the original SDK.
