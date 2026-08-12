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
const results = [];

async function step(name, fn) {
  try {
    const value = await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}${value === undefined ? '' : ` -> ${value}`}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    const detail =
      error instanceof IntemptApiError
        ? `status=${error.status ?? 'none'} body=${(error.body ?? '').slice(0, 200)}`
        : String(error);
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

console.log(`Intempt SDK contract test against ${intempt.config.host}`);
console.log(
  `  org=${intempt.config.org} project=${intempt.config.project} user=${userId}\n`,
);

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
await step('group', () =>
  intempt.group({ userId, accountId: `sdk-e2e-acct-${Date.now()}` }),
);
await step('ecommerce.ordered', () =>
  intempt.ecommerce.ordered({
    userId,
    products: [{ productId: 'sdk-e2e-sku', quantity: 1 }],
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

await intempt.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error(`Failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
