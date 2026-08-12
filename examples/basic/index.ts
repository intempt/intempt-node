/**
 * Runnable sample app.
 *
 * It installs the SDK from a packed tarball, exactly as a customer would, so it
 * proves the published artifact works: the `exports` map resolves, the shipped
 * `.d.ts` typechecks, and every namespace is callable.
 *
 * By default it points at a local mock server, so `npm start` works offline with
 * no credentials. Point it at staging by setting the environment:
 *
 *   INTEMPT_HOST=api.staging.intempt.com \
 *   INTEMPT_ORG=my-org INTEMPT_PROJECT=my-project \
 *   INTEMPT_API_KEY=prefix.secret INTEMPT_SOURCE_ID=123 \
 *   npm start
 */
import { Intempt, IntemptApiError, type IntemptClient } from 'intempt';
import { startMockApi } from './mock-api';

const useMock = !process.env.INTEMPT_API_KEY;

async function main(): Promise<void> {
  const mock = useMock ? await startMockApi() : undefined;

  const intempt: IntemptClient = Intempt.init({
    org: process.env.INTEMPT_ORG ?? 'demo-org',
    project: process.env.INTEMPT_PROJECT ?? 'demo-project',
    apiKey: process.env.INTEMPT_API_KEY ?? 'demoprefix.demosecret',
    sourceId: process.env.INTEMPT_SOURCE_ID ?? '1',
    host: mock ? mock.host : (process.env.INTEMPT_HOST ?? 'api.intempt.com'),
    protocol: mock ? 'http' : 'https',
    timeout: 10_000,
  });

  const userId = `demo-${Date.now()}`;

  try {
    // ---- identity ----
    await intempt.identify({ userId, traits: { plan: 'pro', seats: 12 } });
    log('identify');

    await intempt.group({
      userId,
      accountId: 'acme-inc',
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
    await intempt.ecommerce.productViewed({ userId, productId: 'sku-42' });
    await intempt.ecommerce.addedToCart({ userId, productId: 'sku-42', quantity: 2 });
    await intempt.ecommerce.ordered({
      userId,
      products: [
        { productId: 'sku-42', quantity: 2 },
        { productId: 'sku-7', quantity: 1 },
      ],
    });
    log('ecommerce (viewed, cart, ordered)');

    // ---- consent ----
    await intempt.consent.grant({ userId, category: 'marketing' });
    await intempt.consent.revoke({ userId, category: 'marketing', reason: 'demo' });
    log('consent (grant, revoke)');

    // ---- decisions out ----
    // Experiments and personalizations are browser-side: they resolve a web
    // experience against a page, so there is nothing for a server to ask for.
    const feed = await intempt.recommend({
      userId,
      feedId: process.env.INTEMPT_E2E_FEED_ID ?? '1',
      limit: 3,
      fields: ['id', 'title'],
    });
    log(`recommend -> ${JSON.stringify(feed).slice(0, 60)}`);

    // ---- privacy ----
    intempt.optOut();
    await intempt.track('should_not_send', { userId });
    log(`optOut suppresses writes (isOptedIn=${intempt.isOptedIn()})`);
    intempt.optIn();

    // ---- buffered mode ----
    const buffered = Intempt.init({
      org: process.env.INTEMPT_ORG ?? 'demo-org',
      project: process.env.INTEMPT_PROJECT ?? 'demo-project',
      apiKey: process.env.INTEMPT_API_KEY ?? 'demoprefix.demosecret',
      sourceId: process.env.INTEMPT_SOURCE_ID ?? '1',
      host: mock ? mock.host : (process.env.INTEMPT_HOST ?? 'api.intempt.com'),
      protocol: mock ? 'http' : 'https',
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
