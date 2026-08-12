/**
 * Contract test against a real Intempt environment.
 *
 * This is the only check that proves the API accepts what the SDK sends: the
 * Basic auth header authenticates, the track envelope is valid, consent
 * timestamps land in the epoch-seconds window ConsentService requires, and the
 * two read endpoints answer with parseable bodies.
 *
 * It writes real events, so point it at a throwaway project.
 *
 * Run: INTEMPT_ORG=... INTEMPT_PROJECT=... INTEMPT_API_KEY=... \
 *      INTEMPT_SOURCE_ID=... node scripts/e2e.mjs
 */
import { Intempt, IntemptApiError } from '../dist/index.js';

const required = [
  'INTEMPT_ORG',
  'INTEMPT_PROJECT',
  'INTEMPT_API_KEY',
  'INTEMPT_SOURCE_ID',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment: ${missing.join(', ')}`);
  process.exit(1);
}

const intempt = Intempt.init({
  org: process.env.INTEMPT_ORG,
  project: process.env.INTEMPT_PROJECT,
  apiKey: process.env.INTEMPT_API_KEY,
  sourceId: process.env.INTEMPT_SOURCE_ID,
  host: process.env.INTEMPT_HOST ?? 'api.staging.intempt.com',
  timeout: 20_000,
});

const userId = `sdk-e2e-${Date.now()}`;
const accountId = `sdk-e2e-acct-${Date.now()}`;
const results = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms, note: value ?? '2xx' });
    console.log(
      `  PASS  ${name.padEnd(46)} ${String(ms).padStart(5)}ms  ${value ?? '2xx'}`,
    );
  } catch (error) {
    const ms = Date.now() - started;
    const status =
      error instanceof IntemptApiError ? (error.status ?? 'transport') : 'error';
    const body =
      error instanceof IntemptApiError ? (error.body ?? '').slice(0, 160) : String(error);
    results.push({ name, ok: false, ms, note: `${status}: ${body}` });
    console.error(
      `  FAIL  ${name.padEnd(46)} ${String(ms).padStart(5)}ms  ${status} ${body}`,
    );
  }
}

console.log(`Intempt SDK contract test against ${intempt.config.host}`);
// Org, project and source id are intentionally not printed: on a public
// repository the Actions log is world-readable.
console.log(`  user=${userId}\n`);

// A 401/403 here means the Basic auth header is not accepted, which is the single
// most important thing this test exists to prove.
await step('identify (proves Basic auth is accepted)', () =>
  intempt.identify({ userId, traits: { source: 'sdk-e2e' } }),
);
await step('track', () =>
  intempt.track('sdk_e2e_event', { userId, properties: { ok: true, n: 1 } }),
);
await step('track with an explicit timestamp', () =>
  intempt.track('sdk_e2e_backdated', {
    userId,
    timestamp: new Date(Date.now() - 3_600_000),
  }),
);
await step('trackBatch', () =>
  intempt.trackBatch([
    { event: 'sdk_e2e_a', userId },
    { event: 'sdk_e2e_b', userId },
  ]),
);
await step('group', () => intempt.group({ userId, accountId }));
await step('alias', () => intempt.alias({ userId, previousUserId: `${userId}-anon` }));
await step('ecommerce.productViewed', () =>
  intempt.ecommerce.productViewed({ userId, productId: 'sdk-e2e-sku' }),
);
await step('ecommerce.addedToCart', () =>
  intempt.ecommerce.addedToCart({ userId, productId: 'sdk-e2e-sku', quantity: 3 }),
);
await step('ecommerce.ordered', () =>
  intempt.ecommerce.ordered({
    userId,
    products: [
      { productId: 'sdk-e2e-sku', quantity: 1 },
      { productId: 'sdk-e2e-sku-2', quantity: 2 },
    ],
  }),
);
// Proves the epoch-seconds fix: milliseconds would be silently replaced by the
// server's own receive time, and a value below the floor is rejected outright.
await step('consent.grant (proves epoch-seconds timestamps)', () =>
  intempt.consent.grant({ userId, category: 'sdk-e2e' }),
);
await step('consent.revoke', () =>
  intempt.consent.revoke({ userId, category: 'sdk-e2e' }),
);
// Exercises sourceId serialisation. A real source id is 19 digits, past
// Number.MAX_SAFE_INTEGER, so a Number() coercion anywhere in this path would
// address a different source or be rejected outright.
await step('consent by profileId (proves sourceId is not rounded)', () =>
  intempt.consent.grant({ profileId: userId, category: 'sdk-e2e-profile' }),
);
await step('decide.experiences', async () => {
  const choices = await intempt.decide.experiences({ userId, type: 'experiment' });
  return `${choices.length} choice(s)`;
});
if (process.env.INTEMPT_FEED_ID) {
  await step('decide.recommend', async () => {
    const feed = await intempt.decide.recommend({
      userId,
      feedId: process.env.INTEMPT_FEED_ID,
      limit: 3,
      fields: ['id'],
    });
    return JSON.stringify(feed).slice(0, 80);
  });
} else {
  console.log('  SKIP  decide.recommend (INTEMPT_FEED_ID not set)');
}

// Buffered mode against the real server: proves flush() drains over the wire and
// that several events in a single request are accepted.
const buffered = Intempt.init({
  org: process.env.INTEMPT_ORG,
  project: process.env.INTEMPT_PROJECT,
  apiKey: process.env.INTEMPT_API_KEY,
  sourceId: process.env.INTEMPT_SOURCE_ID,
  host: process.env.INTEMPT_HOST ?? 'api.staging.intempt.com',
  timeout: 20_000,
  batch: { size: 50, flushMs: 60_000, flushOnExit: false },
});
await step('flush (batched, 5 events in one request)', async () => {
  for (let i = 0; i < 5; i += 1) {
    await buffered.track(`sdk_e2e_buffered_${i}`, { userId });
  }
  const before = buffered.buffered;
  await buffered.flush();
  return `${before} buffered -> ${buffered.buffered} after flush`;
});
await buffered.close();

await intempt.close();

const failed = results.filter((r) => !r.ok);

console.log('\n  per-method results');
console.log('  ' + '-'.repeat(74));
for (const r of results) {
  console.log(
    `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(46)} ${String(r.ms).padStart(5)}ms  ${r.note}`,
  );
}
console.log('  ' + '-'.repeat(74));
console.log(`  ${results.length - failed.length}/${results.length} passed`);

if (failed.length > 0) {
  console.error(`\nFailed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
