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
import { readFileSync } from 'node:fs';
import { Intempt, IntemptApiError } from '../dist/index.js';

// --- .env.local -------------------------------------------------------------
// .env.example tells you to copy it to .env.local, so something has to read it.
// Deliberately not a dependency: this is a handful of lines and the file format
// is trivial. Real environment variables always win, so CI is unaffected.
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

const envFile = new URL('../.env.local', import.meta.url).pathname;
const loadedCount = loadEnvFile(envFile);

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
// group() provisions the account, so a fixed id is enough and keeps runs idempotent.
const accountId = ACCOUNT_ID ?? 'sdk-e2e-account';

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
  ['accountId (optional)', ACCOUNT_ID, 'group — created automatically if absent'],
  ['feed id', FEED_ID, 'recommend'],
  ['productId', PRODUCT_ID, 'ecommerce.*'],
];

console.log(`\nIntempt SDK contract test — ${HOST}`);
if (loadedCount > 0) {
  console.log(`  loaded ${loadedCount} value(s) from .env.local`);
}
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

/**
 * A 2xx that cannot distinguish success from silence.
 *
 * The feeds endpoint answers 200 with an empty array both when the feed is
 * missing and when it exists with nothing to return — AbstractFeedDataService
 * does `if (feed == null) return new ArrayList<>()`. Marking that PASS would be a
 * false green, so it is counted as not verified.
 */
function inconclusive(name, ms, why) {
  results.push({ name, state: 'WARN', ms, note: why });
  console.log(`  WARN  ${name.padEnd(46)} ${String(ms).padStart(5)}ms  ${why}`);
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

// group() creates the account if it does not exist, so no pre-existing account
// is required. A fixed id keeps runs idempotent.
await step('group (creates the account if absent)', () =>
  intempt.group({ userId, accountId }),
);

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

// --- reads ---------------------------------------------------------------------
// Experiments and personalizations are absent by design: they resolve a web
// experience against a page and are served by the browser SDK.
if (FEED_ID) {
  const label = 'recommend (feeds identify by {id, type})';
  const started = Date.now();
  try {
    const feed = await intempt.recommend({
      userId,
      feedId: FEED_ID,
      limit: 3,
      fields: (process.env.INTEMPT_E2E_FEED_FIELDS ?? 'id')
        .split(',')
        .map((f) => f.trim()),
    });
    const ms = Date.now() - started;
    const rows = Object.values(feed ?? {}).find(Array.isArray) ?? [];
    if (rows.length === 0) {
      inconclusive(
        label,
        ms,
        `200 but empty ${JSON.stringify(feed)} — a missing feed answers exactly the ` +
          `same way, so this proves nothing. Confirm feed ${FEED_ID} exists in this ` +
          'project and has an algorithm configured.',
      );
    } else {
      results.push({ name: label, state: 'PASS', ms, note: `${rows.length} product(s)` });
      console.log(
        `  PASS  ${label.padEnd(46)} ${String(ms).padStart(5)}ms  ${rows.length} product(s)`,
      );
    }
  } catch (error) {
    const ms = Date.now() - started;
    const status =
      error instanceof IntemptApiError ? (error.status ?? 'transport') : 'error';
    const body =
      error instanceof IntemptApiError ? (error.body ?? '').slice(0, 160) : String(error);
    results.push({ name: label, state: 'FAIL', ms, note: `${status}: ${body}` });
    console.error(
      `  FAIL  ${label.padEnd(46)} ${String(ms).padStart(5)}ms  ${status} ${body}`,
    );
  }
} else {
  skip('recommend', 'INTEMPT_E2E_FEED_ID not set — feed must exist');
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
const warned = results.filter((r) => r.state === 'WARN');

console.log('\n  per-method results');
console.log('  ' + '-'.repeat(76));
for (const r of results) {
  console.log(
    `  ${r.state}  ${r.name.padEnd(46)} ${r.ms ? String(r.ms).padStart(5) + 'ms' : '       '}  ${r.note}`,
  );
}
console.log('  ' + '-'.repeat(76));
console.log(
  `  ${passed.length} passed · ${failed.length} failed · ` +
    `${warned.length} inconclusive · ${skipped.length} skipped`,
);

const unverified = [...warned, ...skipped];
if (unverified.length > 0) {
  console.log(`\n  NOT verified against the API:`);
  for (const r of unverified) console.log(`    - ${r.name}\n        ${r.note}`);
}

if (failed.length > 0) {
  console.error(`\nFailed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
