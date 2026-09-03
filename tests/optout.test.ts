import { describe, expect, it } from 'vitest';
import {
  CONSENT_PATH,
  ORIGIN,
  TRACK_PATH,
  client,
  feedPath,
  nock,
  setupNock,
} from './helpers';

setupNock();

describe('optOut gates every write path', () => {
  it('suppresses track, trackBatch, identify and group', async () => {
    const c = client();
    c.optOut();

    await c.track('purchase', { userId: 'u1' });
    await c.trackBatch([{ event: 'a', userId: 'u1' }]);
    await c.identify({ userId: 'u1' });
    await c.group({ userId: 'u1', accountId: 'a1' });

    // nock.disableNetConnect means any real request would have thrown.
    expect(nock.pendingMocks()).toEqual([]);
    expect(c.isOptedIn()).toBe(false);
  });

  it('suppresses commerce events', async () => {
    const c = client();
    c.optOut();

    await c.ecommerce.productViewed({ userId: 'u1', productId: 'p1' });
    await c.ecommerce.addedToCart({ userId: 'u1', productId: 'p1', quantity: 2 });
    await c.ecommerce.ordered({ userId: 'u1', products: [{ productId: 'p1' }] });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('suppresses consent records', async () => {
    // 1.x gated only tracking; consent, choose and feeds still sent the
    // profile identifier after optOut(). That was the privacy defect.
    const c = client();
    c.optOut();

    await c.consent.grant({ userId: 'u1' });
    await c.consent.revoke({ userId: 'u1' });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('still validates arguments while opted out', async () => {
    const c = client();
    c.optOut();
    await expect(c.track('purchase', {})).rejects.toThrow(/one of userId/);
  });

  it('resumes sending after optIn', async () => {
    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    const c = client();

    c.optOut();
    await c.track('a', { userId: 'u1' });
    expect(scope.isDone()).toBe(false);

    c.optIn();
    await c.track('b', { userId: 'u1' });
    expect(scope.isDone()).toBe(true);
  });
});

describe('optOut does not gate reads', () => {
  it('leaves recommend working', async () => {
    // It takes an identifier the caller already holds and returns a decision
    // rather than storing anything, so suppressing it would break
    // recommendations for a user who only opted out of collection.
    const feed = nock(ORIGIN).post(feedPath('42')).reply(200, { items: [] });

    const c = client();
    c.optOut();

    await c.recommend({ userId: 'u1', feedId: '42', limit: 3, fields: ['id'] });

    feed.done();
  });
});

describe('close', () => {
  it('throws on a write once closed', async () => {
    const c = client();
    await c.close();

    await expect(c.track('purchase', { userId: 'u1' })).rejects.toThrow(
      /client is closed/,
    );
    expect(nock.pendingMocks()).toEqual([]);
    expect(c.isOptedIn()).toBe(false);
  });

  it('is idempotent', async () => {
    const c = client();
    await c.close();
    await expect(c.close()).resolves.toBeUndefined();
  });

  it('reports nothing buffered when batching is off', async () => {
    expect(client().buffered).toBe(0);
    await client().flush();
  });
});

describe('consent path is separate from track', () => {
  it('posts to /consents/data', async () => {
    const scope = nock(ORIGIN).post(CONSENT_PATH).reply(200, '');
    await client().consent.grant({ userId: 'u1' });
    scope.done();
  });
});
