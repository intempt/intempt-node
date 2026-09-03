# CLAUDE.md

Context for AI assistants working in this repository. Every rule here was earned
by a specific failure, and each one says which, so it can be argued with rather
than obeyed blindly.

## What this package is

`intempt` — the server-side Node SDK. **Data in, decisions out, nothing else.**

| Direction | Surface                                                                   |
| --------- | ------------------------------------------------------------------------- |
| in        | `track` `trackBatch` `identify` `group` `consent.*` `ecommerce.*` |
| out       | `recommend`                                                               |

Configuration and analysis operations belong to `@intempt/cli` and
`@intempt/mcp-server`, which already carry ~202 of them. If an operation is not
on a customer's request path, it does not belong here.

The browser SDK is [intempt-js](https://github.com/intempt/intempt-js). This one
holds no per-user state: every call takes its identifier explicitly, so one
client instance is safe to share across requests.

## Before adding a method

**Check `registry.ts` in the `cli` repo first.** Twice during the v2 rebuild a
method was proposed that the CLI and MCP server already exposed — `users/create`,
`accounts/create`, `add-tags`, `owners`. Duplicating management surface here
means two places to change and two places to get wrong.

**Only expose what a customer's server can legitimately supply.** Two platform
identifiers are deliberately absent:

- `profileId` is minted by the browser SDK and lives on the device. A server that
  invents one creates an orphan profile that never stitches to a real visitor.
- `masterId` is assigned internally after identity resolution. There is no read
  path to obtain one from here, and a hardcoded one breaks the moment two
  profiles merge.

Identity merge is not exposed for the same reason, plus it is irreversible and
has no inverse endpoint anywhere in the platform. There is no alias surface
either: declare identity with `identify()` and let the platform resolve it from
shared identifiers.

## Wire-format rules that have already caused bugs

**Never put a platform ID through `Number()`.** A real `sourceId` such as
`1841503112918048768` is 19 digits, past `Number.MAX_SAFE_INTEGER`, so `Number()`
silently rounds it to `...048800` and addresses a different source. Nothing
throws. The API declares these fields with `LongFromStringDeserializer`
specifically so clients can send strings. Send strings.

**Timestamp units differ per endpoint.** `/track` takes epoch **milliseconds**.
`/consents/data` takes epoch **seconds** — it compares `timestamp * 1000` against
millisecond bounds, so milliseconds land far in the future and the server quietly
substitutes its own receive time. Every client-supplied consent timestamp was
being discarded before this was found.

**The feeds API identifies by `{id, type}`, not by `userId`.** `FeedRequest` has
no `userId` or `profileId` field at all, so those are dropped on the floor and
the request resolves no entity. 1.x sent `userId`, which is why server-side
recommendations never worked. `type` is `user`, `account` or `profile`.

**Do not be stricter than the API without evidence.** A `groups` XOR `names` rule
was invented for `choose-api`; the API marks both optional and accepts them
together. Inventing a constraint removes capability for no reason. Where the API
_does_ constrain, mirror it: experience names must match `^[a-zA-Z0-9_-]+$`, and
checking that locally turns an opaque 400 into a message naming the bad value.

## TypeScript

**`private` is erased at compile time.** Every `private readonly` field is a
public JavaScript property. Before this was fixed, the API secret was reachable
as `client.transport.credentials.toHttpBasicAuth()`, and `client.optedIn = true`
defeated `optOut()`. Use `#private` fields and methods for anything that must not
be reachable. `tests/encapsulation.test.ts` walks the public object graph and
fails if an internal is ever demoted.

**Freeze deeply or do not claim frozen.** `Object.freeze({ ...config })` is
shallow, and the copied `batch` reference was the batcher's live options object,
so `config.batch.maxQueue = 0` made every later event look queue-full.

**Truthiness is not presence.** `userId: '   '` is truthy and used to reach the
wire, keying a profile on a run of spaces. Trim before deciding a value is
absent — and apply it everywhere, not just the first call site found. `group`,
`alias` and `consent` all missed the first pass.

## Testing

Six layers, in increasing fidelity. Add to the layer that can actually catch the
class of bug you are fixing.

| Layer                       | Catches                                            | Network      |
| --------------------------- | -------------------------------------------------- | ------------ |
| `tests/*.test.ts` (nock)    | intent, validation, retry branches                 | none         |
| `tests/integration.test.ts` | header framing, keep-alive, timeouts, dead sockets | loopback     |
| `tests/adversarial.test.ts` | hostile input, races, credential leaks             | loopback     |
| `tests/fix-audit.test.ts`   | over-correction in previous fixes                  | loopback     |
| `npm run verify:consumer`   | packaging: `exports`, `files`, shipped `.d.ts`     | loopback     |
| `npm run test:e2e`          | whether the API accepts what we send               | real project |

**`tests/integration.test.ts` must not import `tests/helpers.ts`.** That helper
imports `nock`, and nock patches `http.ClientRequest` at import time, so every
request in the file becomes a nock passthrough — which sends `Connection: close`
and ignores the agent. The keep-alive and concurrency assertions passed against
nock and failed against a real socket. Keep that file nock-free or it tests the
harness.

**When a test fails, prove the harness before changing the code.** Several
apparent defects were test bugs: `.query(true)` also matches no query;
`WeakMap`-keyed socket identity does not survive the mock socket; too few nock
interceptors makes an unmocked request retry on a 20-second backoff, which looks
exactly like a hang. Fixing the SDK for any of those would have been wrong.

**Never fabricate an entity ID in a real-API test.** Ingestion returns **201 for
unknown accounts and products**, so a made-up `productId` produces a green test
that proves nothing about the catalog. `scripts/e2e.mjs` reports `SKIP` when a
project input is missing and lists it under "NOT verified against the API".

**Give read endpoints a negative control.** A missing feed and a working feed
with no matches both answer 200 with an empty array, so an empty result proves
nothing on its own. A nonexistent feed id answers 400, so the contract test
asserts both: real feed → 200, bogus feed → 400. Without the second, the first
is vacuous.

## Release

- Publishing happens on a `v*.*.*` tag, never on a push to `main`. The old
  workflow ran `npm publish` on every push, which fails when the version is
  unchanged — it failed silently for 21 months while npm served 1.0.1.
- `main` requires one approving review with `enforce_admins` on. Nobody bypasses
  it.
- `npm publish --provenance` requires a **public** repository. Making this repo
  private breaks the release workflow.
- The tarball is an allowlist (`files` in `package.json`), not `.npmignore`. A
  live API key shipped to npm for over a year because `.npmignore` said `test`
  while the directory was `tests`. CI fails the build if anything outside
  `dist/` and the docs enters the tarball.
- `min-release-age` in `.npmrc` is honoured by pnpm and recent npm, and ignored
  by npm 10 which ships with Node 20 and 22. Dependabot plus the committed
  lockfile are what actually gate dependency changes.

## Attribution

Roughly 190 lines derive from
[mixpanel-node](https://github.com/mixpanel/mixpanel-node) (MIT, Carl Sverre).
`NOTICE` records what is verbatim versus adapted, per file. Keep it accurate when
touching `config.ts`, `credentials.ts`, `transport.ts`, `stamp.ts`, `utils.ts` or
the batch-ceiling logic in `batcher.ts`.

## Known platform issues, not SDK bugs

Do not try to fix these here.

1. `400 "Can't create a collection for auto-event"` is intermittent when a
   request carries many new event names. A 400 tells clients not to retry, so a
   transient server condition silently drops a batch on a first run with a large
   tracking plan. Should be 429 or 503.
2. `filterTimeAttributesNames` in audience-service binds a comma-joined string
   into `IN (?)`, so it never matches and TIME product attributes are never
   timezone-cast. Parameter-bound, so not injectable, just wrong.
3. Whether the event store honours a client-supplied `timestamp` or stamps
   arrival time is **unverified**. Do not document `timestamp` as a backfill
   guarantee until someone confirms it in `cdp-data-processor`.
