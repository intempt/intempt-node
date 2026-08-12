# Intempt Node.js SDK

Server-side client for [Intempt](https://intempt.com). Data in, decisions out.

- **In** — events, identity, consent, commerce
- **Out** — experiences, personalizations, recommendations

Console and configuration operations are deliberately not here. Those live in
the [Intempt CLI and MCP server](https://github.com/intempt/cli).

```bash
npm install intempt
```

Requires Node 18 or newer.

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

const variants = await intempt.decide.experiences({
  userId: 'user@example.com',
  type: 'experiment',
});
```

By default each call sends one request and the promise resolves when the server
responds. Nothing is buffered, so there is nothing to lose on exit — which makes
this safe in Lambda and other short-lived processes.

## Configuration

```ts
Intempt.init({
  org: 'my-org',                 // required
  project: 'my-project',         // required
  apiKey: 'prefix.secret',       // required, public API key
  sourceId: '6845...',           // optional, see below

  host: 'api.intempt.com',       // 'host' or 'host:port'
  protocol: 'https',
  path: '',                      // prefix before /v1, for a gateway
  timeout: 10_000,
  keepAlive: true,

  logger: console,               // needs trace/debug/info/warn/error
  debug: false,

  batch: false,                  // see Batching
  maxRequestEvents: 50,          // hard ceiling on events per request
  stampLibVersion: false,        // see Library identity
});
```

`sourceId` selects the ingestion source. With it, events go to
`/sources/{sourceId}/track`; without it, to `/track`. It is also required by the
API for consent records that identify a person by `profileId`.

Call `setConfig()` to change any of these on a live client, except `org`,
`project`, `apiKey`, `sourceId` and `batch`.

### Identifiers

Every call takes at least one of `userId`, `profileId` or `accountId`. You do
not need a `profileId`: the API accepts `userId` on its own and links it to a
profile for you. Consent also accepts `masterId`.

## Sending data

```ts
await intempt.track('purchase', {
  userId: 'u1',
  properties: { total: 99.99 },
  timestamp: new Date(),        // optional; Date or epoch ms
});

await intempt.trackBatch([
  { event: 'page_view', userId: 'u1', properties: { path: '/pricing' } },
  { event: 'signup', userId: 'u2' },
]);

await intempt.identify({ userId: 'u1', traits: { plan: 'pro' } });
await intempt.group({ userId: 'u1', accountId: 'acme', attributes: { tier: 'enterprise' } });
await intempt.alias({ userId: 'u1', previousUserId: 'anon-abc' });
```

`trackBatch` chunks at `maxRequestEvents`, so a 500-event array becomes ten
requests rather than one oversized one.

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
await intempt.consent.revoke({ userId: 'u1', category: 'marketing', reason: 'user request' });
```

`validUntil` defaults to `'unlimited'`. Timestamps are converted to the epoch
seconds the API expects.

## Reading decisions

```ts
const variants = await intempt.decide.experiences({
  userId: 'u1',
  type: 'experiment',       // or 'personalization'
  names: ['checkout-test'], // or groups: ['homepage']
});

const feed = await intempt.decide.recommend({
  userId: 'u1',
  feedId: '848',
  limit: 5,
  fields: ['id', 'title', 'price'],
});
```

## Privacy

```ts
intempt.optOut();          // suppresses every write: events, commerce, consent
intempt.isOptedIn();       // false
intempt.optIn();
```

`optOut()` covers all outbound writes. Read-side `decide` calls still work: they
send an identifier you already hold and return a decision without storing
anything, so a user who opted out of collection still gets a working experience.

## Batching

Off by default. Turn it on for a long-lived, high-volume process:

```ts
const intempt = Intempt.init({
  org, project, apiKey, sourceId,
  batch: {
    size: 50,          // buffered events that trigger a flush
    flushMs: 5_000,    // idle time before a flush
    maxQueue: 10_000,  // ceiling; beyond it events are dropped and logged
    flushOnExit: true, // flush on process 'beforeExit'
  },
});

await intempt.track('page_view', { userId: 'u1' }); // resolves once buffered

await intempt.flush();  // drain now
await intempt.close();  // drain, then release timers and sockets
intempt.buffered;       // events still queued
```

`flush()` and `close()` are safe to call when batching is off; they do nothing.

Retry policy:

| Response | Behaviour |
|---|---|
| 413, batch > 1 | halve the batch size, retry |
| 413, batch = 1 | drop the event, log it |
| 429 | honour `Retry-After`, else exponential backoff |
| 5xx, 408, timeout | exponential backoff, capped at 10 minutes |
| other 4xx | drop the batch, log the status and body |
| 5 consecutive failures | stop batching and say how many events are stranded |

The buffer is in memory. A hard crash loses it. Crash durability needs disk with
fsync and boot-time recovery, which is a different design.

## Errors

Every method returns a promise that rejects on failure. Nothing is swallowed.

```ts
import { IntemptApiError } from 'intempt';

try {
  await intempt.track('purchase', { userId: 'u1' });
} catch (error) {
  if (error instanceof IntemptApiError) {
    error.status;       // 429, 500, undefined on a transport failure
    error.body;         // response body
    error.retryAfterMs; // parsed Retry-After
    error.retryable;    // 408, 429, 5xx, transport errors and timeouts
  }
}
```

## Library identity

Every request carries `X-Intempt-Lib: intempt-node/<version>`, so a bad batch
can be traced to an SDK version. Set `stampLibVersion: true` to also add
`$lib` and `$libVersion` to each event payload — off by default, because a new
payload field can affect a downstream event schema.

## Migrating from 1.x

`new SDK(...)` still works, forwards to the new client, and warns once. It will
be removed in 3.0.0.

```ts
const sdk = new SDK(org, project, apiKey, sourceId);
const client = sdk.v2; // the 2.x client, for incremental migration
```

Breaking changes to expect:

| 1.x | 2.x |
|---|---|
| `?apiKey=` query parameter | `Authorization: Basic` header |
| invalid input warns and resolves | rejects |
| product helpers return `{ error: true }` | reject |
| `trackingClient` and friends | removed |
| `NODE_ENV=test` targets staging | `host` is configuration |
| `optOut()` gates tracking only | gates every write |
| consent timestamp in milliseconds | seconds, as the API expects |
| `profileId` required | any one identifier |
| `choosePersonalizationsByGroups` and 3 more | `decide.experiences({ type })` |
| `recommendation(...)` | `decide.recommend({ ... })` |
| unbounded resend, no flush | buffering is opt-in, with `flush`/`close` |

## Not in this SDK

| Capability | Where it lives |
|---|---|
| Journeys, experiences, dashboards, segments, deals, brand | CLI and MCP server |
| Tags and owner assignment | CLI and MCP server |
| Profile and account creation | CLI and MCP server |
| Identity merge | not exposed; use `alias()` |
| Content and design generation | blocked: those endpoints require a bearer JWT with a `person_id` claim, and no API-key path exists |

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Tests never touch the network; `nock` intercepts everything and unmocked
requests fail.

## License

MIT. See [LICENSE](./LICENSE), and [NOTICE](./NOTICE) for the mixpanel-node
code this SDK derives from.
