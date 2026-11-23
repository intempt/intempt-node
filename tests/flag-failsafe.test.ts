import { afterEach, describe, expect, it } from 'vitest';
import {
  FLAG_ALL_PATH,
  FLAG_EVALUATE_PATH,
  ORIGIN,
  client,
  nock,
  setupNock,
  testLogger,
} from './helpers';
import type { FlagError } from '../src';

setupNock();

/**
 * S11: no flag call throws. Each failure returns the code default with reason `error` and an
 * OpenFeature error code, and a caller mistake logs one warning per key so a typo stays visible.
 * Flag reads time out after 2 s by default (`flagTimeout`); tracking keeps its 10 s `timeout`.
 * No nock interceptor is registered for the refused calls: `disableNetConnect` fails the test if one
 * reaches the wire.
 */
const ctx = { userId: 'u-1' };

function hooked() {
  const errors: FlagError[] = [];
  const logger = testLogger();
  const c = client({ logger, onFlagError: (e) => errors.push(e) });
  return { c, errors, logger };
}

const warnings = (logger: ReturnType<typeof testLogger>) =>
  logger.calls.warn.map((a) => String(a[0]));

describe('a caller mistake returns the default and never throws', () => {
  afterEach(() => nock.cleanAll());

  it.each(['', '   ', 'new checkout', 'has.dot', 'a/b'])(
    'key %j -> default, FLAG_NOT_FOUND, no request',
    async (key) => {
      const { c } = hooked();
      await expect(c.variationDetail(key, ctx, false)).resolves.toEqual({
        value: false,
        reason: 'error',
        errorCode: 'FLAG_NOT_FOUND',
      });
      await expect(c.boolVariation(key, ctx, true)).resolves.toBe(true);
      await c.close();
    },
  );

  it('a non-string key is FLAG_NOT_FOUND too', async () => {
    const { c } = hooked();
    await expect(c.variation(42 as never, ctx, 'd')).resolves.toBe('d');
    await c.close();
  });

  it.each([
    ['no context', undefined],
    ['an empty context', {}],
    ['a blank userId', { userId: '   ' }],
    ['accountId only', { accountId: 'acme' }],
  ])('%s -> default, TARGETING_KEY_MISSING, no request', async (_label, context) => {
    const { c } = hooked();
    await expect(c.variationDetail('k', context as never, 'd')).resolves.toEqual({
      value: 'd',
      reason: 'error',
      errorCode: 'TARGETING_KEY_MISSING',
    });
    await c.close();
  });

  it('a profileId without a configured sourceId is TARGETING_KEY_MISSING', async () => {
    const c = client({ sourceId: undefined });
    await expect(
      c.variationDetail('k', { profileId: 'p-1' }, 'd'),
    ).resolves.toMatchObject({
      value: 'd',
      errorCode: 'TARGETING_KEY_MISSING',
    });
    await c.close();
  });

  it('a missing default -> undefined with GENERAL, no request', async () => {
    const { c } = hooked();
    await expect(
      c.variationDetail('k', ctx, undefined as unknown as string),
    ).resolves.toEqual({ value: undefined, reason: 'error', errorCode: 'GENERAL' });
    await c.close();
  });

  it('allFlags with no usable identity returns an empty map and never throws', async () => {
    const { c } = hooked();
    await expect(c.allFlags({})).resolves.toEqual({});
    await c.close();
  });

  it('warns once per key, not once per call, and names the key', async () => {
    const { c, errors, logger } = hooked();
    await c.variation('bad key', ctx, 0);
    await c.variation('bad key', ctx, 0);
    await c.variation('other.key', ctx, 0);
    await c.variation('k', {}, 0);
    await c.variation('k', {}, 0);

    const w = warnings(logger);
    expect(w).toHaveLength(3);
    expect(w[0]).toContain('"bad key"');
    expect(w[1]).toContain('"other.key"');
    expect(w[2]).toContain('"k"');
    expect(w[2]).toMatch(/userId, or profileId together with a sourceId/);
    expect(errors).toEqual([]);
    await c.close();
  });

  it('names accountId when that is what the caller passed', async () => {
    const { c, logger } = hooked();
    await c.variation('k', { accountId: 'acme' } as never, 0);
    expect(warnings(logger)[0]).toContain('accountId is not an identifier');
    await c.close();
  });

  it('keeps warning about new keys after many distinct bad keys', async () => {
    const { c, logger } = hooked();
    for (let i = 0; i < 1_100; i += 1) await c.variation(`bad key ${i}`, ctx, 0);
    await c.variation('bad key 0', ctx, 0);
    // The remembered set is bounded: once full it starts over, so memory stays flat and a key
    // seen long ago can warn again rather than never.
    expect(warnings(logger).length).toBeGreaterThanOrEqual(1_100);
    expect(warnings(logger).length).toBeLessThanOrEqual(1_101);
    await c.close();
  });

  it('a closed client is still refused loudly: that is a lifecycle error, not a flag read', async () => {
    const c = client();
    await c.close();
    await expect(c.variation('k', ctx, 'd')).rejects.toThrow(/closed/);
  });
});

describe('a failed read carries an error code', () => {
  afterEach(() => nock.cleanAll());

  it('404 "Flag not found" -> FLAG_NOT_FOUND', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(404, { message: 'Flag not found' });
    const { c, errors } = hooked();
    await expect(c.variationDetail('gone', ctx, false)).resolves.toEqual({
      value: false,
      reason: 'error',
      errorCode: 'FLAG_NOT_FOUND',
      error: { key: 'gone', kind: 'bad_request', status: 404 },
    });
    expect(errors).toHaveLength(1);
    await c.close();
  });

  it.each([400, 500, 503])('status %i -> GENERAL', async (status) => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(status, {});
    const { c } = hooked();
    await expect(c.variationDetail('k', ctx, 'd')).resolves.toMatchObject({
      value: 'd',
      reason: 'error',
      errorCode: 'GENERAL',
    });
    await c.close();
  });

  it('a disableExposure read whose key is absent from /flags/all -> FLAG_NOT_FOUND', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, { flags: [] });
    const { c } = hooked();
    await expect(
      c.variationDetail('k', ctx, 'd', { disableExposure: true }),
    ).resolves.toEqual({ value: 'd', reason: 'error', errorCode: 'FLAG_NOT_FOUND' });
    await c.close();
  });
});

describe('flag timeout (S11 #3)', () => {
  afterEach(() => nock.cleanAll());

  it('defaults to 2 s, separate from the 10 s tracking timeout', () => {
    const c = client();
    expect(c.config.flagTimeout).toBe(2_000);
    expect(c.config.timeout).toBe(10_000);
  });

  it('a flag read gives up after flagTimeout, even when timeout is longer', async () => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .delay(300)
      .reply(200, { key: 'k', value: 'late' });
    const errors: FlagError[] = [];
    const c = client({
      timeout: 10_000,
      flagTimeout: 50,
      onFlagError: (e) => errors.push(e),
    });
    await expect(c.variationDetail('k', ctx, 'd')).resolves.toMatchObject({
      value: 'd',
      errorCode: 'GENERAL',
    });
    expect(errors).toEqual([{ key: 'k', kind: 'timeout' }]);
    await c.close();
  });

  it('is validated at init and at setConfig', () => {
    expect(() => client({ flagTimeout: 0 })).toThrow(/flagTimeout/);
    expect(() => client({ flagTimeout: Number.NaN })).toThrow(/flagTimeout/);
    const c = client();
    expect(() => c.setConfig({ flagTimeout: -1 })).toThrow(/flagTimeout/);
    c.setConfig({ flagTimeout: 750 });
    expect(c.config.flagTimeout).toBe(750);
    c.setConfig({ debug: false });
    expect(c.config.flagTimeout).toBe(750);
  });
});
