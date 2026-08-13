# Intempt Node.js SDK

[![Tests](https://github.com/intempt/intempt-node/actions/workflows/tests.yml/badge.svg)](https://github.com/intempt/intempt-node/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/intempt.svg)](https://www.npmjs.com/package/intempt)
[![node](https://img.shields.io/node/v/intempt.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/intempt.svg)](./LICENSE)

Server-side client for [Intempt](https://intempt.com). **Data in, decisions out.**

- **In** — events, identity, consent, commerce
- **Out** — experiences, personalizations, recommendations

This is a server library, not a browser one. It holds no per-user state: every
call takes its identifier explicitly, so one client instance is safe to share
across requests for all users. For the browser, use
[intempt-js](https://github.com/intempt/intempt-js).

Console and configuration operations are deliberately not here — see
[Not in this SDK](#not-in-this-sdk).

```bash
npm install intempt
```

Requires Node 20 or newer. Written in TypeScript; types ship with the package.

- [Changelog](./CHANGELOG.md)
- [Security policy](./SECURITY.md)
- [Sample app](./examples/basic)

## The Intempt toolchain

| Tool                                                | For                  | Use it when                                                |
| --------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| **`intempt`** (this package)                        | your server          | sending events, reading decisions on the request path      |
| [intempt-js](https://github.com/intempt/intempt-js) | the browser          | client-side auto-tracking, page and session context        |
| [`@intempt/cli`](https://github.com/intempt/cli)    | your terminal and CI | tracking plans, typed wrapper codegen, coverage checks     |
| `@intempt/mcp-server`                               | AI agents            | journeys, dashboards, segments, brand — the management API |

If an operation is configuration or analysis rather than something on a
customer request path, it belongs in the CLI or MCP server, not here.

## Quick start

```ts
import { Intempt } from 'intempt';

const intempt = Intempt.init({
  org: 'my-org',
  project: 'my-project',
  apiKey: process.env.INTEMPT_API_KEY!, // "<prefix>.<secret>"
  sourceId: '684508596718616576',
});

await intempt.track('purchase', {
  userId: 'user@example.com',
  properties: { total: 99.99, currency: 'USD' },
});

const feed = await intempt.recommend({
  userId: 'user@example.com',
  feedId: '5292',
  fields: ['id', 'title'],
});
```

By default each call sends one request and the promise resolves when the server
responds. Nothing is buffered, so there is nothing to lose on exit — which makes
this safe in Lambda and other short-lived processes.

## API reference

| Call                               | Returns            | Endpoint                             |
| ---------------------------------- | ------------------ | ------------------------------------ |
| `Intempt.init(config)`             | `IntemptClient`    | —                                    |
| `track(event, options)`            | `Promise<void>`    | `POST …/track`                       |
| `trackBatch(events)`               | `Promise<void>`    | `POST …/track`, chunked              |
| `identify(options)`                | `Promise<void>`    | `POST …/track` (reserved `Identify`) |
| `group(options)`                   | `Promise<void>`    | `POST …/track` (reserved `Identify`) |
| `alias(options)`                   | `Promise<void>`    | `POST …/track` (reserved `Identify`) |
| `consent.grant(options)`           | `Promise<void>`    | `POST …/consents/data`               |
| `consent.revoke(options)`          | `Promise<void>`    | `POST …/consents/data`               |
| `ecommerce.productViewed(options)` | `Promise<void>`    | `POST …/track`                       |
| `ecommerce.addedToCart(options)`   | `Promise<void>`    | `POST …/track`                       |
| `ecommerce.ordered(options)`       | `Promise<void>`    | `POST …/track`                       |
| `recommend(options)`               | `Promise<unknown>` | `POST …/feeds/{id}/data`             |
| `optIn()` / `optOut()`             | `void`             | —                                    |
| `isOptedIn()`                      | `boolean`          | —                                    |
| `flush()` / `close()`              | `Promise<void>`    | —                                    |
| `setConfig(patch)`                 | `void`             | —                                    |
| `config` / `buffered`              | getters            | —                                    |

Every method rejects on failure. Nothing is swallowed.

## Configuration

```ts
Intempt.init({
  org: 'my-org', // required
  project: 'my-project', // required
  apiKey: 'prefix.secret', // required, public API key
  sourceId: '6845...', // optional, see below

  host: 'api.intempt.com', // 'host' or 'host:port'
  protocol: 'https',
  path: '', // prefix before /v1, for a gateway
  timeout: 10_000,
  keepAlive: true,

  logger: console, // needs trace/debug/info/warn/error
  debug: false,

  batch: false, // see Batching
  maxRequestEvents: 50, // hard ceiling on events per request
  maxConcurrentRequests: 1, // in-flight requests per trackBatch call
  agent: undefined, // your own https.Agent, for mTLS or a private CA
});
```

`sourceId` selects the ingestion source. With it, events go to
`/sources/{sourceId}/track`; without it, to `/track`. It is also required by the
API for consent records that identify a person by `profileId`.

Call `setConfig()` to change any of these on a live client, except `org`,
`project`, `apiKey`, `sourceId`, `batch`, `keepAlive` and `agent`. The last two are
fixed because the HTTP agents are built once at construction; the type rejects
them, so it is a compile error rather than a runtime surprise.

### Identifiers

Every call takes at least one of two identifiers, and both are values you
already own:

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| `userId`    | your identifier for a person: an email, an internal user id |
| `accountId` | your identifier for a company or account                    |

That is the whole list. The platform resolves identity from `userId` itself.

Two platform identifiers are deliberately **not** exposed:

- **`profileId`** is the anonymous id the browser SDK mints and keeps on the
  device. A server that invents one creates an orphan profile that never
  stitches to a real visitor.
- **`masterId`** is assigned internally after identity resolution. There is no
  way to look one up from here, and a hardcoded one breaks the moment two
  profiles merge.

If you need to tie server events to a visitor's pre-login browser activity,
send the `userId` as soon as you know it and let the platform stitch. Same
reasoning as [`alias()`](#sending-data): declare identity, don't manage it.

## Sending data

```ts
await intempt.track('purchase', {
  userId: 'u1',
  properties: { total: 99.99 },
  timestamp: new Date(), // optional; Date or epoch ms
});

await intempt.trackBatch([
  { event: 'page_view', userId: 'u1', properties: { path: '/pricing' } },
  { event: 'signup', userId: 'u2' },
]);

await intempt.identify({ userId: 'u1', traits: { plan: 'pro' } });
await intempt.group({
  userId: 'u1',
  accountId: 'acme',
  attributes: { tier: 'enterprise' },
});
await intempt.alias({ userId: 'u1', previousUserId: 'anon-abc' });
```

`trackBatch` chunks at `maxRequestEvents`, so a 500-event array becomes ten
requests rather than one oversized one. Those chunks go out one at a time by
default; raise `maxConcurrentRequests` to overlap them:

```ts
Intempt.init({ ...config, maxConcurrentRequests: 4 });
```

Workers pull from a shared cursor, so a slow request never stalls the others and
no more than `maxConcurrentRequests` are ever in flight. If any chunk fails, the
call rejects with the first error only after every sibling request has settled, so
a rejection can never leave an unhandled promise behind.

`alias` declares two identities as the same person and lets the platform resolve
them. The destructive `/users/merge` endpoint is not exposed here: it has no
inverse and takes internal numeric IDs this SDK cannot resolve.

### Commerce

```ts
await intempt.ecommerce.productViewed({ userId: 'u1', productId: 'sku-1' });
await intempt.ecommerce.addedToCart({ userId: 'u1', productId: 'sku-1', quantity: 2 });
await intempt.ecommerce.ordered({
  userId: 'u1',
  products: [{ productId: 'sku-1', quantity: 2 }],
});
```

These wrap `track` with the reserved event names the platform recognises.

### Consent

```ts
await intempt.consent.grant({ userId: 'u1', category: 'marketing' });
await intempt.consent.revoke({
  userId: 'u1',
  category: 'marketing',
  reason: 'user request',
});
```

`validUntil` defaults to `'unlimited'`. Timestamps are converted to the epoch
seconds the API expects.

## Reading decisions

```ts
const feed = await intempt.recommend({
  userId: 'u1', // or accountId, not both
  feedId: '5292',
  limit: 5,
  fields: ['id', 'title', 'price'], // product attribute names from your catalog
});
```

`fields` are **product attribute names from your catalog schema**, not arbitrary
keys. `limit` is optional and falls back to the feed's own setting.

The feeds API identifies an entity by an `{id, type}` pair rather than by
`userId`, so the SDK maps `userId` to `type: 'user'` and `accountId` to
`type: 'account'`. That is why the two are mutually exclusive here, unlike on the
tracking calls.

### Why there are no experiments or personalizations

They resolve a **web experience against a page**, and are served by the browser
SDK, [intempt-js](https://github.com/intempt/intempt-js). A server has no page to
modify, so `/optimization/choose-api` is not part of this surface.

The 1.x `chooseExperimentsBy*` and `choosePersonalizationsBy*` helpers throw a
message pointing at the browser SDK rather than returning an empty array: `[]`
reads as "no variant assigned" and would silently disable a caller's experiment
instead of telling them where it moved.

## Privacy

```ts
intempt.optOut(); // suppresses every write: events, commerce, consent
intempt.isOptedIn(); // false
intempt.optIn();
```

`optOut()` covers all outbound writes. `recommend()` still works: it
send an identifier you already hold and return a decision without storing
anything, so a user who opted out of collection still gets a working experience.

## Batching

Off by default. Turn it on for a long-lived, high-volume process:

```ts
const intempt = Intempt.init({
  org,
  project,
  apiKey,
  sourceId,
  batch: {
    size: 50, // buffered events that trigger a flush
    flushMs: 5_000, // idle time before a flush
    maxQueue: 10_000, // ceiling; beyond it events are dropped and logged
    flushOnExit: true, // flush on process 'beforeExit'
  },
});

await intempt.track('page_view', { userId: 'u1' }); // resolves once buffered

await intempt.flush(); // drain now
await intempt.close(); // drain, then release timers and sockets
intempt.buffered; // events still queued
```

`flush()` and `close()` are safe to call when batching is off; they do nothing.

Retry policy:

| Response                | Behaviour                                               |
| ----------------------- | ------------------------------------------------------- |
| 413, batch > 1          | halve the batch size, retry                             |
| 413, batch = 1          | drop the event, log it                                  |
| 429                     | honour `Retry-After`, else exponential backoff          |
| 5xx, 408, timeout       | exponential backoff, floored at 100ms, capped at 10 min |
| other 4xx               | drop the batch, log the status and body                 |
| 5 consecutive failures  | stop batching and say how many events are stranded      |
| 3 consecutive 413 drops | say the gateway limit is the likely cause, once         |

Two details worth knowing about the width, because both are visible in your
request count.

A 413 halves the width, and the width only widens again after ten consecutive
successful sends that filled it, doubling each time. So one transient 413 costs
throughput for a while rather than forever — an earlier version never recovered at
all, and resetting to full immediately just alternates 413/200 at double the
request count.

A 413 on a single event drops that event and returns the width to full, because the
oversized event is gone and the width was never the problem. If drops keep coming
with nothing accepted in between — a gateway whose body limit sits below one event
— the SDK says so once and otherwise carries on unchanged.

That tally is diagnostic only, and deliberately so. Two earlier versions used it to
change behaviour and both were worse than what they fixed. Stopping batching
stranded the buffer and discarded every later event, where the original merely lost
the events that were genuinely too large. Pinning the width to 1 capped throughput
to one event per round trip, and since the width then has to climb back through the
widening ramp — 37 requests to deliver 120 events against 15 — a producer faster
than that overflows `maxQueue` and good events are lost. Trading delivered events
for a lower request count is the wrong direction.

The cost that remains is about `log2(batch.size)` requests per dropped event, since
the halving chain replays each time. It is only paid while events are being
dropped, which is already logged on every occurrence.

The buffer is in memory. A hard crash loses it. Crash durability needs disk with
fsync and boot-time recovery, which is a different design.

## TLS, proxies and private CAs

Keep-alive agents are created for you, and `HTTPS_PROXY` / `HTTP_PROXY` are
honoured. For anything beyond that — mutual TLS, a private certificate
authority, a bespoke proxy policy — pass your own agent:

```ts
import https from 'node:https';

Intempt.init({
  ...config,
  agent: new https.Agent({
    ca: fs.readFileSync('corporate-ca.pem'),
    cert: fs.readFileSync('client.pem'),
    key: fs.readFileSync('client.key'),
    keepAlive: true,
  }),
});
```

Your agent is used verbatim: the SDK creates none of its own and ignores
`keepAlive`, `HTTPS_PROXY` and `HTTP_PROXY`, so nothing is silently layered over
your TLS configuration. It is also yours to destroy — `close()` leaves it alone.

Match the protocol. An `http.Agent` on an `https` client dials port 80 and the
request fails; use `https.Agent` unless you set `protocol: 'http'`.

## Errors

Every method returns a promise that rejects on failure. Nothing is swallowed.

```ts
import { IntemptApiError } from 'intempt';

try {
  await intempt.track('purchase', { userId: 'u1' });
} catch (error) {
  if (error instanceof IntemptApiError) {
    error.status; // 429, 500, undefined on a transport failure
    error.body; // response body
    error.retryAfterMs; // parsed Retry-After
    error.retryable; // 408, 429, 5xx, transport errors and timeouts
  }
}
```

## Library identity

Every request carries `X-Intempt-Lib: intempt-node/<version>`, so a bad batch
can be traced to an SDK version. Nothing is added to the event payload: a new
payload field could affect a downstream event schema, and a header cannot.

## Migrating from 1.x

`new SDK(...)` still works, forwards to the new client, and warns once. It will
be removed in 3.0.0.

```ts
const sdk = new SDK(org, project, apiKey, sourceId);
const client = sdk.v2; // the 2.x client, for incremental migration
```

Breaking changes to expect:

| 1.x                                         | 2.x                                       |
| ------------------------------------------- | ----------------------------------------- |
| `?apiKey=` query parameter                  | `Authorization: Basic` header             |
| invalid input warns and resolves            | rejects                                   |
| product helpers return `{ error: true }`    | reject                                    |
| `trackingClient` and friends                | removed                                   |
| `NODE_ENV=test` targets staging             | `host` is configuration                   |
| `optOut()` gates tracking only              | gates every write                         |
| consent timestamp in milliseconds           | seconds, as the API expects               |
| `profileId` required                        | any one identifier                        |
| `choosePersonalizationsByGroups` and 3 more | throw — browser SDK only                  |
| `recommendation(...)`                       | `recommend({ userId, feedId, fields })`   |
| unbounded resend, no flush                  | buffering is opt-in, with `flush`/`close` |

## Not in this SDK

| Capability                                                | Where it lives                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Journeys, experiences, dashboards, segments, deals, brand | CLI and MCP server                                                                                 |
| Tags and owner assignment                                 | CLI and MCP server                                                                                 |
| Profile and account creation                              | CLI and MCP server                                                                                 |
| Identity merge                                            | not exposed; use `alias()`                                                                         |
| Content and design generation                             | blocked: those endpoints require a bearer JWT with a `person_id` claim, and no API-key path exists |

## Development

```bash
npm ci
npm run check-format     # prettier
npm run lint             # oxlint
npm run typecheck        # tsc --noEmit
npm test                 # vitest, offline
npm run test:coverage
npm run build
npm run verify:consumer  # pack, install, typecheck and run the sample app
```

Four layers of verification, in increasing fidelity:

| Layer                       | What it proves                                                                                                                                                    | Network        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `tests/*.test.ts` (nock)    | what the SDK intends to send, and every branch of validation and retry                                                                                            | none           |
| `tests/integration.test.ts` | what actually crosses a socket: header framing, keep-alive reuse, timeouts, the concurrency cap                                                                   | real, loopback |
| `npm run verify:consumer`   | the published tarball installs, its `exports` map resolves, the shipped `.d.ts` typechecks under stricter settings than the library uses, and the sample app runs | real, loopback |
| `npm run test:e2e`          | the Intempt API _accepts_ what we send                                                                                                                            | real, staging  |

`tests/integration.test.ts` deliberately does not import the shared test helpers,
because those load `nock`, and nock patches `http.ClientRequest` at import time.
That would turn its "real socket" assertions into assertions about nock.

Only `test:e2e` needs credentials, and it needs more than a key: several methods
touch entities that must already exist in the project — an account, a catalog
product, a feed, a published experiment. See [`.env.example`](./.env.example) for
the full input list; copy it to `.env.local` and the contract test picks it up
automatically. Any step whose input is missing is reported as **SKIP**, never
as a pass: ingestion returns 201 for unknown ids, so a fabricated value would look
green and prove nothing.

See [`examples/basic`](./examples/basic) for a runnable sample app.

## Sample app

[`examples/basic`](./examples/basic) exercises every namespace and runs offline
against a local mock API, so `npm run verify:consumer` works with no credentials.
Point it at a real environment with `INTEMPT_HOST`, `INTEMPT_ORG`,
`INTEMPT_PROJECT`, `INTEMPT_API_KEY` and `INTEMPT_SOURCE_ID`.

## FAQ

**Why does every call need an identifier? Why is there no stateful `identify()`?**

This library is stateless by design, so one instance can be shared across
requests for every user. Client-side SDKs tie one instance to one user and can
hold a `profileId`; a server cannot. Pass `userId` or `accountId` with each call.

**Do I need a `profileId`?**

No. The API accepts `userId` on its own and links it to a profile for you.

**Where is `users.merge()` / profile merging?**

Deliberately absent. Merging is irreversible, no inverse endpoint exists, and it
takes internal numeric IDs this SDK has no way to resolve. Use `alias()` and let
the platform resolve identity itself. If you genuinely need a merge, do it
through the CLI or MCP server, where a human confirms it.

**Which API key should I use?**

A **public** key. It carries exactly the ingestion scopes this SDK needs. Never
deploy a private or admin key in an application server — those grant full
project access. See [SECURITY.md](./SECURITY.md).

**Can I generate emails, images or copy with this SDK?**

Not yet. Those endpoints authenticate with a bearer JWT tied to a person, and
there is no API-key path into them, so it cannot be done from a server key.
Use the CLI or MCP server today.

**Should I turn batching on?**

Only for a long-lived, high-volume process. The default sends one request per
call and resolves when the server responds, which is the right behaviour for
Lambda and anything that can exit at any moment. See [Batching](#batching).

**Is `timestamp` a backfill mechanism?**

Treat it as unconfirmed. The ingestion API forwards a client timestamp, but
whether the event store honours it or stamps arrival time is not yet verified.
Do not build a historical import on it without checking.

## Support

- Bugs and feature requests: [open an issue](https://github.com/intempt/intempt-node/issues)
- Security reports: **security@intempt.com** — please do not use a public issue
- Platform documentation: [docs.intempt.com](https://docs.intempt.com)

## Contributing

```bash
git clone https://github.com/intempt/intempt-node.git
cd intempt-node
npm ci
npm run check-format && npm run lint && npm run typecheck && npm test
npm run verify:consumer
```

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `chore:`, …) and are checked in CI, because the release notes are
generated from the commit log. Every change needs a test, and
`tests/integration.test.ts` must stay free of `nock` — see
[Development](#development) for why.

## Attribution and credits

This SDK derives roughly 190 lines from
[mixpanel-node](https://github.com/mixpanel/mixpanel-node): its configuration
object, credential handling, keep-alive and proxy agent setup, response
classification, library-version reporting, and the batch-size ceiling with 413
halving.

Copyright (c) 2012 Carl Sverre, MIT licensed. Both projects are MIT.
[NOTICE](./NOTICE) records what is copied verbatim versus adapted, per file.

The HTTP transport, wire format, endpoints, retry policy and every public method
signature are Intempt's own.

## License

MIT. See [LICENSE](./LICENSE), and [NOTICE](./NOTICE) for the mixpanel-node
code this SDK derives from.
