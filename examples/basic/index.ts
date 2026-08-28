/**
 * Runnable sample app.
 *
 * It installs the SDK from a packed tarball, exactly as a customer would, so it
 * proves the published artifact works: the `exports` map resolves, the shipped
 * `.d.ts` typechecks, and every namespace is callable.
 *
 * By default it points at a local mock server, so `npm start` works offline with
 * no credentials. Set INTEMPT_API_KEY and it talks to the real API instead:
 *
 *   INTEMPT_HOST=api.intempt.com \
 *   INTEMPT_ORGANIZATION_ID=my-org INTEMPT_PROJECT_ID=my-project \
 *   INTEMPT_API_KEY=prefix.secret INTEMPT_SOURCE_ID=1841... \
 *   INTEMPT_E2E_USER_ID=someone@example.com \
 *   INTEMPT_E2E_PRODUCT_ID=21 INTEMPT_E2E_FEED_ID=5292 \
 *   npm start
 *
 * Against a real project, supply the object ids: a fabricated productId is
 * accepted with a 201 and proves nothing about your catalog.
 */
import { Intempt, IntemptApiError, type IntemptClient } from 'intempt-nodejs-sdk';
import { startMockApi } from './mock-api';

const useMock = !process.env.INTEMPT_API_KEY;

const env = (...names: string[]): string | undefined => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return undefined;
};

function baseConfig(mockHost?: string) {
  return {
    org: env('INTEMPT_ORGANIZATION_ID', 'INTEMPT_ORG') ?? 'demo-org',
    project: env('INTEMPT_PROJECT_ID', 'INTEMPT_PROJECT') ?? 'demo-project',
    apiKey: env('INTEMPT_API_KEY') ?? 'demoprefix.demosecret',
    sourceId: env('INTEMPT_SOURCE_ID') ?? '1',
    host: mockHost ?? env('INTEMPT_HOST') ?? 'api.intempt.com',
    protocol: (mockHost ? 'http' : 'https') as 'http' | 'https',
  };
}

async function main(): Promise<void> {
  const mock = useMock ? await startMockApi() : undefined;

  const intempt: IntemptClient = Intempt.init({
    ...baseConfig(mock?.host),
    timeout: 15_000,
  });

  // Real project ids where supplied; the mock accepts anything.
  const userId = env('INTEMPT_E2E_USER_ID') ?? `demo-${Date.now()}`;
  const accountId = env('INTEMPT_E2E_ACCOUNT_ID') ?? 'demo-account';
  const productId = env('INTEMPT_E2E_PRODUCT_ID') ?? 'sku-42';
  const feedId = env('INTEMPT_E2E_FEED_ID') ?? '1';

  console.log(`  target: ${mock ? 'local mock' : baseConfig().host}`);
  console.log(`  profile: ${userId}\n`);

  try {
    // ---- identity ----
    await intempt.identify({ userId, traits: { plan: 'pro', seats: 12 } });
    log('identify');

    await intempt.group({
      userId,
      accountId,
      attributes: { tier: 'enterprise', domain: 'acme.com' },
    });
    log('group');

    await intempt.alias({ userId, previousUserId: 'anon-abc123' });
    log('alias');

    // ---- events ----
    await intempt.track('pricing_viewed', {
      userId,
      properties: { plan: 'pro', currency: 'USD' },
    });
    log('track');

    await intempt.trackBatch([
      { event: 'docs_viewed', userId, properties: { path: '/docs/node' } },
      { event: 'search', userId, properties: { query: 'batching' } },
      { event: 'signup_started', userId },
    ]);
    log('trackBatch (3 events)');

    // ---- commerce ----
    await intempt.ecommerce.productViewed({ userId, productId });
    await intempt.ecommerce.addedToCart({ userId, productId, quantity: 2 });
    await intempt.ecommerce.ordered({ userId, products: [{ productId, quantity: 2 }] });
    log(`ecommerce viewed/cart/ordered (product ${productId})`);

    // ---- consent ----
    await intempt.consent.grant({ userId, category: 'marketing' });
    await intempt.consent.revoke({ userId, category: 'marketing', reason: 'demo' });
    log('consent (grant, revoke)');

    // ---- decisions out ----
    // Experiments and personalizations are browser-side: they resolve a web
    // experience against a page, so there is nothing for a server to ask for.
    const feed = await intempt.recommend({
      userId,
      feedId,
      limit: 3,
      fields: (env('INTEMPT_E2E_FEED_FIELDS') ?? 'id').split(',').map((f) => f.trim()),
    });
    const rows = Object.values((feed ?? {}) as Record<string, unknown>).find(
      Array.isArray,
    );
    log(
      `recommend (feed ${feedId}) -> ${rows?.length ?? 0} row(s) ` +
        `${JSON.stringify(feed).slice(0, 50)}`,
    );

    // ---- flags ----
    // Ask for a KEY. Whether it names an experiment, a personalization or a flag is the
    // platform's business, and the method name does not change when that changes.
    const context = { userId, profileId: 'device-abc' };

    // The default is not optional, and it is a real decision: it is what runs when Intempt cannot
    // be reached. Choose the behaviour you already have.
    const cta = await intempt.stringVariation('pricing_cta', context, 'Get started');
    log(`stringVariation pricing_cta -> ${cta}`);

    const checkout = await intempt.boolVariation('new_checkout', context, false);
    log(`boolVariation new_checkout -> ${checkout}`);

    const all = await intempt.allFlags(context);
    log(`allFlags -> ${Object.keys(all).length} key(s): ${Object.keys(all).join(', ')}`);

    // What happens when Intempt is unreachable. No throw, no null — the value you chose.
    const offline = Intempt.init({ ...baseConfig('127.0.0.1:1'), timeout: 200 });
    const fallback = await offline.stringVariation('pricing_cta', context, 'Get started');
    log(`during an outage -> ${fallback} (your default, no throw)`);
    await offline.close();

    // ---- privacy ----
    intempt.optOut();
    await intempt.track('should_not_send', { userId });
    log(`optOut suppresses writes (isOptedIn=${intempt.isOptedIn()})`);
    intempt.optIn();

    // ---- config ----
    intempt.setConfig({ timeout: 20_000 });
    log(`setConfig -> timeout=${intempt.config.timeout}, buffered=${intempt.buffered}`);

    // ---- buffered mode ----
    const buffered = Intempt.init({
      ...baseConfig(mock?.host),
      batch: { size: 10, flushMs: 2_000 },
      maxConcurrentRequests: 4,
    });
    for (let i = 0; i < 5; i += 1) {
      await buffered.track(`buffered_${i}`, { userId });
    }
    log(`buffered ${buffered.buffered} event(s) before flush`);
    await buffered.flush();
    log(`buffered ${buffered.buffered} event(s) after flush`);
    await buffered.close();

    await intempt.close();

    if (mock) {
      log(`mock server saw ${mock.requestCount()} request(s)`);
      await mock.stop();
    }

    console.log('\nSample app completed successfully.');
  } catch (error) {
    if (error instanceof IntemptApiError) {
      console.error(
        `\nIntempt API error: status=${error.status ?? 'none'} retryable=${error.retryable}`,
      );
      console.error(`body: ${error.body ?? '(empty)'}`);
    } else {
      console.error('\nUnexpected failure:', error);
    }
    if (mock) await mock.stop();
    process.exitCode = 1;
  }
}

function log(step: string): void {
  console.log(`  ok  ${step}`);
}

void main();
