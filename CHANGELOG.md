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
  **The exposed key must be rotated; that is not something this release can do.**
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
  *seconds*; the SDK sent milliseconds, so the server always substituted its
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
- `decide.experiences({ type })` replaces four `choose*` methods.
- `X-Intempt-Lib: intempt-node/<version>` on every request. Nothing is added to
  the event payload: a new payload field could affect a downstream event schema,
  and a header cannot.
- Every internal is a true `#private` field, so no part of the object graph
  reaches the transport, the credential, or a namespace's dependencies.
- `IntemptApiError` with `status`, `body`, `retryAfterMs` and `retryable`.
- 176 tests, all offline via `nock`, with an 80% coverage gate.
- CI on pull requests across Node 18, 20 and 22. Publishing moved to version
  tags with npm provenance.

### Changed

- `axios` replaced by `node:https` plus `https-proxy-agent`. One runtime
  dependency, matching mixpanel-node's approach.
- Node 18 or newer is required.
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

## [1.0.1] — 2024-11-13

Last release of the original SDK.
