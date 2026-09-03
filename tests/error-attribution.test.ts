import { describe, expect, it } from 'vitest';
import { SDK } from '../src';
import {
  API_KEY,
  HOST,
  ORG,
  ORIGIN,
  PROJECT,
  SOURCE,
  TRACK_PATH,
  client,
  nock,
  setupNock,
} from './helpers';

setupNock();

/**
 * Every assertion here checks *which* method an error blames, not merely that one
 * was thrown.
 *
 * Mutation testing surfaced this: the suite matched fragments like
 * `/one of userId/`, so Stryker could rewrite `'productViewed'` to `'ordered'`
 * and every test still passed. An error naming the wrong method sends a caller
 * to the wrong line, which is a real cost when the SDK is a dependency they
 * cannot step into.
 */

describe('ecommerce reports the method the caller actually invoked', () => {
  it.each([
    [
      'productViewed',
      (c: ReturnType<typeof client>) => c.ecommerce.productViewed({ productId: 'p' }),
    ],
    [
      'addedToCart',
      (c: ReturnType<typeof client>) =>
        c.ecommerce.addedToCart({ productId: 'p', quantity: 1 }),
    ],
    [
      'ordered',
      (c: ReturnType<typeof client>) =>
        c.ecommerce.ordered({ products: [{ productId: 'p' }] }),
    ],
  ])('%s names itself when no identifier is given', async (method, call) => {
    await expect(call(client())).rejects.toThrow(
      new RegExp(`^${method}: one of userId or accountId is required$`),
    );
  });

  it.each([
    [
      'productViewed',
      (c: ReturnType<typeof client>) => c.ecommerce.productViewed({} as never),
    ],
    [
      'addedToCart',
      (c: ReturnType<typeof client>) => c.ecommerce.addedToCart({ quantity: 1 } as never),
    ],
  ])('%s names itself when productId is missing', async (method, call) => {
    await expect(call(client())).rejects.toThrow(
      new RegExp(`^${method}: productId is required$`),
    );
  });
});

describe('ingest reports the method the caller actually invoked', () => {
  it('identify names identify, not track', async () => {
    await expect(client().identify({} as never)).rejects.toThrow(
      /^identify: one of userId or accountId is required$/,
    );
  });

  it('track names track', async () => {
    await expect(client().track('purchase', {})).rejects.toThrow(
      /^track: one of userId or accountId is required$/,
    );
  });

  it('group names group for a blank accountId, and says which field', async () => {
    await expect(client().group({ userId: 'u', accountId: ' ' })).rejects.toThrow(
      /^group: accountId must be a non-empty string$/,
    );
  });

  it('accepts group with only an accountId, which is itself an identifier', async () => {
    // Worth pinning: this is why group() needs no assertIdentifier call.
    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    await expect(client().group({ accountId: 'a' } as never)).resolves.toBeUndefined();
    scope.done();
  });


  it.each([
    [
      'identify',
      (c: ReturnType<typeof client>) => c.identify({ userId: 'u', event: ' ' }),
    ],
    [
      'group',
      (c: ReturnType<typeof client>) =>
        c.group({ userId: 'u', accountId: 'a', event: ' ' }),
    ],
  ])('%s names itself when an explicit event is blank', async (method, call) => {
    await expect(call(client())).rejects.toThrow(
      new RegExp(`^${method}: event must be a non-empty string when provided$`),
    );
  });

  it('trackBatch names the offending index, not just the method', async () => {
    await expect(
      client().trackBatch([
        { event: 'ok', userId: 'u' },
        { event: '', userId: 'u' },
      ]),
    ).rejects.toThrow(/^trackBatch\[1\]: event name is required$/);

    await expect(
      client().trackBatch([{ event: 'ok', userId: 'u' }, { event: 'ok' } as never]),
    ).rejects.toThrow(/^trackBatch\[1\]: one of userId or accountId is required$/);
  });

  it('track names the reserved event it refused', async () => {
    await expect(client().track('Identify', { userId: 'u' })).rejects.toThrow(
      /^track: "Identify" is reserved; use identify\(\) or group\(\)$/,
    );
  });
});

describe('recommend and consent name themselves', () => {
  it('recommend names recommend for each precondition', async () => {
    const c = client();
    await expect(c.recommend({ userId: 'u', fields: ['id'] } as never)).rejects.toThrow(
      /^recommend: feedId is required$/,
    );
    await expect(c.recommend({ userId: 'u', feedId: 'f', fields: [] })).rejects.toThrow(
      /^recommend: fields must be a non-empty array$/,
    );
    await expect(
      c.recommend({ userId: 'u', feedId: 'f', fields: ['id'], limit: 0 }),
    ).rejects.toThrow(/^recommend: limit must be a positive integer$/);
    await expect(c.recommend({ feedId: 'f', fields: ['id'] } as never)).rejects.toThrow(
      /^recommend: one of userId or accountId is required$/,
    );
  });

  it('consent distinguishes grant from revoke in its message', async () => {
    await expect(client().consent.grant(undefined as never)).rejects.toThrow(
      /^consent\.grant: options are required$/,
    );
    await expect(client().consent.revoke(undefined as never)).rejects.toThrow(
      /^consent\.revoke: options are required$/,
    );
  });
});

describe('the legacy shim names the exact helper that moved', () => {
  it.each([
    'chooseExperimentsByGroups',
    'chooseExperimentsByNames',
    'choosePersonalizationsByGroups',
    'choosePersonalizationsByNames',
  ] as const)('%s names itself, so a caller can find the call site', (method) => {
    // All four throw the same sentence apart from the method name. Asserting only
    // the shared part let a mutant swap one name for another undetected, which
    // would point a caller at a function they never called.
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ host: HOST });
    expect(() => sdk[method]()).toThrow(new RegExp(`^${method} was removed in 2\\.0\\.`));
    void sdk.close();
  });

  it('rejects an unknown consent action with the exact allowed values', async () => {
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ host: HOST });
    await expect(sdk.consents('p1', 'maybe')).rejects.toThrow(
      /^consent: action must be 'accept' or 'reject'$/,
    );
    expect(nock.pendingMocks()).toEqual([]);
    await sdk.close();
  });
});
