/**
 * Contract test against a real Intempt environment.
 *
 * This is the only check that proves the API *accepts* what the SDK sends. The
 * rest of the suite is offline: unit tests use nock, the integration suite uses
 * a loopback server. Neither can catch a wire-format or auth regression.
 *
 * It writes real events. Point it at a project you are happy to write into.
 *
 * Every input that must already exist in the project is optional here, and any
 * step needing a missing input is SKIPPED and counted, never quietly passed.
 * That matters: posting `productId: "made-up-sku"` returns 201 and proves
 * nothing about commerce, because ingestion accepts unknown ids. Acceptance is
 * not correctness.
 *
 * See .env.example for the full input list.
 */
import { Intempt, IntemptApiError } from '../dist/index.js';

// --- inputs -----------------------------------------------------------------
const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return undefined;
};

const HOST = env('INTEMPT_HOST') ?? 'api.intempt.com';
const ORG = env('INTEMPT_ORGANIZATION_ID', 'INTEMPT_ORG');
const PROJECT = env('INTEMPT_PROJECT_ID', 'INTEMPT_PROJECT');
const API_KEY = env('INTEMPT_API_KEY');
const SOURCE_ID = env('INTEMPT_SOURCE_ID');

// Project-resident entities. Absent -> the dependent step is skipped.
const USER_ID = env('INTEMPT_E2E_USER_ID');
const ACCOUNT_ID = env('INTEMPT_E2E_ACCOUNT_ID');
const FEED_ID = env('INTEMPT_E2E_FEED_ID', 'INTEMPT_FEED_ID');
const PRODUCT_ID = env('INTEMPT_E2E_PRODUCT_ID');
const EXPERIMENT_NAME = env('INTEMPT_E2E_EXPERIMENT_NAME');
const EXPERIMENT_GROUP = env('INTEMPT_E2E_EXPERIMENT_GROUP');
const PERSONALIZATION_NAME = env('INTEMPT_E2E_PERSONALIZATION_NAME');
const PERSONALIZATION_GROUP = env('INTEMPT_E2E_PERSONALIZATION_GROUP');

const missingRequired = [
  ['INTEMPT_ORGANIZATION_ID', ORG],
  ['INTEMPT_PROJECT_ID', PROJECT],
  ['INTEMPT_API_KEY', API_KEY],
  ['INTEMPT_SOURCE_ID', SOURCE_ID],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missingRequired.length > 0) {
  console.error(`Missing required input: ${missingRequired.join(', ')}`);
  console.error('See .env.example.');
  process.exit(1);
}

// A stable profile keeps runs idempotent and lets results be eyeballed in the
// console. Minting one per run leaves a trail of junk profiles.
const userId = USER_ID ?? `sdk-e2e-${Date.now()}`;

const clientConfig = {
  org: ORG,
  project: PROJECT,
  apiKey: API_KEY,
  sourceId: SOURCE_ID,
  host: HOST,
  timeout: 20_000,
};
const intempt = Intempt.init(clientConfig);

// --- readiness --------------------------------------------------------------
const inputs = [
  ['stable userId', USER_ID, 'identify, track, group, alias, consent'],
  ['accountId', ACCOUNT_ID, 'group'],
  ['feed id', FEED_ID, 'decide.recommend'],
  ['productId', PRODUCT_ID, 'ecommerce.*'],
  ['experiment name', EXPERIMENT_NAME, 'decide.experiences by name'],
  ['experiment group', EXPERIMENT_GROUP, 'decide.experiences by group'],
  ['personalization name', PERSONALIZATION_NAME, 'decide.experiences by name'],
  ['personalization group', PERSONALIZATION_GROUP, 'decide.experiences by group'],
];

console.log(`\nIntempt SDK contract test — ${HOST}`);
console.log(`  profile: ${userId}${USER_ID ? ' (stable)' : ' (ephemeral)'}\n`);
console.log('  project inputs');
console.log('  ' + '-'.repeat(76));
for (const [name, value, usedBy] of inputs) {
  console.log(`  ${value ? 'have' : 'MISS'}  ${name.padEnd(22)} ${usedBy}`);
}
console.log('  ' + '-'.repeat(76) + '\n');

// --- harness ----------------------------------------------------------------
const results = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - started;
    results.push({ name, state: 'PASS', ms, note: value ?? '2xx' });
    console.log(
      `  PASS  ${name.padEnd(46)} ${String(ms).padStart(5)}ms  ${value ?? '2xx'}`,
    );
  } catch (error) {
    const ms = Date.now() - started;
    const status =
      error instanceof IntemptApiError ? (error.status ?? 'transport') : 'error';
    const body =
      error instanceof IntemptApiError ? (error.body ?? '').slice(0, 160) : String(error);
    results.push({ name, state: 'FAIL', ms, note: `${status}: ${body}` });
    console.error(
      `  FAIL  ${name.padEnd(46)} ${String(ms).padStart(5)}ms  ${status} ${body}`,
    );
  }
}

function skip(name, why) {
  results.push({ name, state: 'SKIP', ms: 0, note: why });
  console.log(`  SKIP  ${name.padEnd(46)}         ${why}`);
}

// --- writes -----------------------------------------------------------------
// A 401 here means the Basic auth header is rejected, which is the single most
// important thing this test exists to prove.
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
await step('trackBatch (2 events, 1 request)', () =>
  intempt.trackBatch([
    { event: 'sdk_e2e_a', userId },
    { event: 'sdk_e2e_b', userId },
  ]),
);

if (ACCOUNT_ID) {
  await step('group (existing account)', () =>
    intempt.group({ userId, accountId: ACCOUNT_ID }),
  );
} else {
  skip('group', 'INTEMPT_E2E_ACCOUNT_ID not set — account must already exist');
}

await step('alias', () => intempt.alias({ userId, previousUserId: `${userId}-anon` }));

if (PRODUCT_ID) {
  await step('ecommerce.productViewed (catalog product)', () =>
    intempt.ecommerce.productViewed({ userId, productId: PRODUCT_ID }),
  );
  await step('ecommerce.addedToCart (catalog product)', () =>
    intempt.ecommerce.addedToCart({ userId, productId: PRODUCT_ID, quantity: 2 }),
  );
  await step('ecommerce.ordered (catalog product, 1 line)', () =>
    intempt.ecommerce.ordered({
      userId,
      products: [{ productId: PRODUCT_ID, quantity: 1 }],
    }),
  );
} else {
  // Ingestion accepts unknown product ids with a 201, so sending a fabricated
  // one would look like a pass and prove nothing about commerce.
  const why = 'INTEMPT_E2E_PRODUCT_ID not set — product must exist in the catalog';
  skip('ecommerce.productViewed', why);
  skip('ecommerce.addedToCart', why);
  skip('ecommerce.ordered', why);
}

await step('consent.grant (proves epoch-seconds timestamps)', () =>
  intempt.consent.grant({ userId, category: 'sdk-e2e' }),
);
await step('consent.revoke', () =>
  intempt.consent.revoke({ userId, category: 'sdk-e2e' }),
);
// profileId is internal-only now, reachable through the deprecated 1.x shim.
// It is still the only consent path that sends sourceId, so it is the only one
// that exercises the 19-digit snowflake serialisation.
await step('consent via 1.x shim path (sourceId not rounded)', () =>
  intempt.consent.grant({ profileId: userId, category: 'sdk-e2e-profile' }),
);

// --- reads ------------------------------------------------------------------
// Unfiltered: proves the endpoint answers. It cannot prove variant resolution,
// because an empty choices array is a valid response for a project with nothing
// published.
await step('decide.experiences (unfiltered)', async () => {
  const c = await intempt.decide.experiences({ userId, type: 'experiment' });
  return `${c.length} choice(s)`;
});
await step('decide.experiences (personalization, unfiltered)', async () => {
  const c = await intempt.decide.experiences({ userId, type: 'personalization' });
  return `${c.length} choice(s)`;
});

for (const [label, type, name, group] of [
  ['experiment', 'experiment', EXPERIMENT_NAME, EXPERIMENT_GROUP],
  ['personalization', 'personalization', PERSONALIZATION_NAME, PERSONALIZATION_GROUP],
]) {
  if (name) {
    // Named lookup is the only form that can prove resolution: a published
    // variant must come back non-empty.
    await step(`decide.experiences by ${label} name`, async () => {
      const c = await intempt.decide.experiences({ userId, type, names: [name] });
      if (c.length === 0)
        throw new Error(`no choices returned for published ${label} "${name}"`);
      return `${c.length} choice(s): ${JSON.stringify(c).slice(0, 90)}`;
    });
  } else {
    skip(
      `decide.experiences by ${label} name`,
      `INTEMPT_E2E_${label.toUpperCase()}_NAME not set`,
    );
  }
  if (group) {
    await step(`decide.experiences by ${label} group`, async () => {
      const c = await intempt.decide.experiences({ userId, type, groups: [group] });
      return `${c.length} choice(s)`;
    });
  } else {
    skip(
      `decide.experiences by ${label} group`,
      `INTEMPT_E2E_${label.toUpperCase()}_GROUP not set`,
    );
  }
}

if (FEED_ID) {
  await step('decide.recommend', async () => {
    const feed = await intempt.decide.recommend({
      userId,
      feedId: FEED_ID,
      limit: 3,
      fields: ['id'],
    });
    return JSON.stringify(feed).slice(0, 110);
  });
} else {
  skip('decide.recommend', 'INTEMPT_E2E_FEED_ID not set — feed must exist');
}

// --- buffered mode ----------------------------------------------------------
const buffered = Intempt.init({
  ...clientConfig,
  batch: { size: 50, flushMs: 60_000, flushOnExit: false },
});
await step('flush (5 events buffered, 1 request)', async () => {
  for (let i = 0; i < 5; i += 1) {
    await buffered.track(`sdk_e2e_buffered_${i}`, { userId });
  }
  const before = buffered.buffered;
  await buffered.flush();
  return `${before} buffered -> ${buffered.buffered} after flush`;
});
await buffered.close();
await intempt.close();

// --- report -----------------------------------------------------------------
const passed = results.filter((r) => r.state === 'PASS');
const failed = results.filter((r) => r.state === 'FAIL');
const skipped = results.filter((r) => r.state === 'SKIP');

console.log('\n  per-method results');
console.log('  ' + '-'.repeat(76));
for (const r of results) {
  console.log(
    `  ${r.state}  ${r.name.padEnd(46)} ${r.ms ? String(r.ms).padStart(5) + 'ms' : '       '}  ${r.note}`,
  );
}
console.log('  ' + '-'.repeat(76));
console.log(
  `  ${passed.length} passed · ${failed.length} failed · ${skipped.length} skipped`,
);

if (skipped.length > 0) {
  console.log(`\n  Not verified against the API (missing project inputs):`);
  for (const r of skipped) console.log(`    - ${r.name}`);
}

if (failed.length > 0) {
  console.error(`\nFailed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
