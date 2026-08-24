import { afterEach, describe, expect, it } from 'vitest';
import { CHOOSE_PATH, ORIGIN, client, nock, setupNock } from './helpers';

setupNock();

/**
 * The cross-SDK flag surface, per `intempt-swift/docs/SDK-API-CONTRACT.md`.
 *
 * The assertions that matter here are the failure ones. A flag SDK is judged on what it returns
 * when the service is unreachable, not on the happy path.
 */
describe('variation', () => {
  afterEach(() => nock.cleanAll());

  const ctx = { userId: 'u-1', profileId: 'p-1' };

  it('returns the served value and its reason', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, {
        choices: [{ name: 'checkout_v2', group: 'B', body: true, reason: 'targeted' }],
      });

    const c = client();
    const detail = await c.variationDetail('checkout_v2', ctx, false);

    expect(detail).toEqual({ value: true, variant: 'B', reason: 'targeted' });
    await c.close();
  });

  it('reports a holdout as a holdout rather than as an absent answer', async () => {
    // The whole reason a reason exists: before it, a held-back person and a failed request were
    // both an absent entry, so a caller could not tell them apart.
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'checkout_v2', body: null, reason: 'holdout' }] });

    const c = client();
    const detail = await c.variationDetail('checkout_v2', ctx, 'fallback');

    expect(detail.reason).toBe('holdout');
    expect(detail.value).toBe('fallback');
    await c.close();
  });

  it('returns the default when the service is unreachable', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, {});

    const c = client();
    await expect(c.variation('checkout_v2', ctx, 'safe')).resolves.toBe('safe');
    await c.close();
  });

  it('returns the default when the key is unknown to the service', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, { choices: [] });

    const c = client();
    const detail = await c.variationDetail('never_created', ctx, 'safe');

    expect(detail.value).toBe('safe');
    expect(detail.reason).toBe('off');
    await c.close();
  });

  it('refuses a call with no defaultValue', async () => {
    const c = client();
    // @ts-expect-error defaultValue is required - this is the point of the assertion
    await expect(c.variation('checkout_v2', ctx)).rejects.toThrow(
      /defaultValue is required/,
    );
    await c.close();
  });

  it('refuses an empty key', async () => {
    const c = client();
    await expect(c.variation('  ', ctx, 'x')).rejects.toThrow(/key is required/);
    await c.close();
  });
});

describe('typed helpers', () => {
  afterEach(() => nock.cleanAll());
  const ctx = { userId: 'u-1' };

  it('falls back rather than coercing a wrong-typed value', async () => {
    // `!!"false"` is true. A silent coercion here would be indistinguishable from a correct answer,
    // which is worse than returning the default the caller chose.
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'f', body: 'false', reason: 'targeted' }] });

    const c = client();
    await expect(c.boolVariation('f', ctx, false)).resolves.toBe(false);
    await c.close();
  });

  it('accepts a correctly typed value', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'f', body: 42, reason: 'targeted' }] });

    const c = client();
    await expect(c.numberVariation('f', ctx, 0)).resolves.toBe(42);
    await c.close();
  });
});

describe('allFlags', () => {
  afterEach(() => nock.cleanAll());

  it('returns every key in one call', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, {
        choices: [
          { name: 'a', body: 1, reason: 'targeted' },
          { name: 'b', body: 2, reason: 'targeted' },
        ],
      });

    const c = client();
    await expect(c.allFlags({ userId: 'u-1' })).resolves.toEqual({ a: 1, b: 2 });
    await c.close();
  });
});

describe('waitForInitialization', () => {
  it('resolves immediately because evaluation is remote', async () => {
    const c = client();
    await expect(c.waitForInitialization(5000)).resolves.toBeUndefined();
    await c.close();
  });
});
