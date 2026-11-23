import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_KEY,
  FLAG_ALL_PATH,
  FLAG_EVALUATE_PATH,
  HOST,
  ORG,
  ORIGIN,
  PROJECT,
  SOURCE,
  client,
  nock,
  setupNock,
  testLogger,
} from './helpers';
import { CACHE_MAX, CACHE_TTL_MS, Flags } from '../src/flags';
import { resolveConfig } from '../src/config';
import { ApiKeyCredentials } from '../src/credentials';
import { Transport } from '../src/transport';

setupNock();

/**
 * F15, the no-stream half (X6 is not built, so this is every read today): ask the server every
 * time; serve the last-known value per (key, identity) only when a call fails, for up to 24 h,
 * with reason `cached`; at most 10,000 entries, oldest dropped. A 404 or 400 never falls back, and
 * an answer that serves nothing (off, killed, not targeted) forgets the entry, so an outage cannot
 * bring a killed flag back.
 */
const user = { userId: 'u-1' };
const DAY = 24 * 60 * 60 * 1000;

function served(value: unknown, path = FLAG_EVALUATE_PATH) {
  nock(ORIGIN)
    .post(path)
    .reply(200, {
      key: 'k',
      value,
      variationId: 4,
      valueType: typeof value,
      reason: 'targeted',
    });
}

function down(status = 503) {
  nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(status, {});
}

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
});

describe('last-known value on failure', () => {
  it('serves the last answer with reason cached when the next call fails', async () => {
    served('blue');
    down();
    const c = client();
    await expect(c.variation('k', user, 'grey')).resolves.toBe('blue');
    await expect(c.variationDetail('k', user, 'grey')).resolves.toEqual({
      value: 'blue',
      reason: 'cached',
      variationId: 4,
      valueType: 'string',
    });
    await c.close();
  });

  it('still asks the server every time: a fresh answer wins over the cache', async () => {
    served('blue');
    served('green');
    const c = client();
    await c.variation('k', user, 'grey');
    await expect(c.variation('k', user, 'grey')).resolves.toBe('green');
    await c.close();
  });

  it.each([
    ['a timeout', () => nock(ORIGIN).post(FLAG_EVALUATE_PATH).delay(200).reply(200, {})],
    [
      'a network error',
      () => nock(ORIGIN).post(FLAG_EVALUATE_PATH).replyWithError('boom'),
    ],
    ['a 500', () => down(500)],
    ['a 429', () => down(429)],
    ['a 408', () => down(408)],
    [
      'an unparseable 200',
      () => nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, '<html>'),
    ],
  ])('falls back on %s', async (_label, fail) => {
    served(true);
    fail();
    const c = client({ flagTimeout: 50 });
    await c.variation('k', user, false);
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      value: true,
      reason: 'cached',
    });
    await c.close();
  });

  it.each([400, 401, 403])('does not fall back on a %i', async (status) => {
    served(true);
    down(status);
    const c = client();
    await c.variation('k', user, false);
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      value: false,
      reason: 'error',
    });
    await c.close();
  });

  it('forgets a deleted flag: a 404 never falls back, and the entry is gone after it', async () => {
    served(true);
    down(404);
    down(503);
    const c = client();
    await c.variation('k', user, false);
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      value: false,
      errorCode: 'FLAG_NOT_FOUND',
    });
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      value: false,
      reason: 'error',
    });
    await c.close();
  });

  it.each(['killed', 'off', 'not_targeted'])(
    'an answer that serves nothing (%s) forgets the entry, so an outage cannot revive it',
    async (reason) => {
      served(true);
      nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, { key: 'k', value: null, reason });
      down();
      const c = client();
      await c.variation('k', user, false);
      await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
        reason,
      });
      await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
        value: false,
        reason: 'error',
      });
      await c.close();
    },
  );

  it('expires after 24 h', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    served(true);
    down();
    down();
    const c = client();
    await c.variation('k', user, false);
    clock.mockReturnValue(now + DAY);
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      reason: 'cached',
    });
    clock.mockReturnValue(now + DAY + 1);
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      reason: 'error',
    });
    await c.close();
  });

  it('re-checks the type of a cached value against the new default', async () => {
    served('blue');
    down();
    const c = client();
    await c.variation('k', user, 'grey');
    await expect(c.variationDetail('k', user, false)).resolves.toMatchObject({
      value: false,
      errorCode: 'TYPE_MISMATCH',
    });
    await c.close();
  });

  it('a disableExposure read shares the cache with a recorded read', async () => {
    served('blue');
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(503, {});
    const c = client();
    await c.variation('k', user, 'grey');
    await expect(c.variation('k', user, 'grey', { disableExposure: true })).resolves.toBe(
      'blue',
    );
    await c.close();
  });
});

describe('the cache key is the identity the server buckets on', () => {
  it('another user does not get my value', async () => {
    served('mine');
    down();
    const c = client();
    await c.variation('k', { userId: 'u-1' }, 'd');
    await expect(c.variation('k', { userId: 'u-2' }, 'd')).resolves.toBe('d');
    await c.close();
  });

  it('a profileId wins over userId, as on the server', async () => {
    served('device');
    down();
    const c = client();
    await c.variation('k', { userId: 'u-1', profileId: 'p-1' }, 'd');
    await expect(
      c.variation('k', { userId: 'u-other', profileId: 'p-1' }, 'd'),
    ).resolves.toBe('device');
    await c.close();
  });

  it('a userId equal to a profileId is a different identity', async () => {
    served('profile');
    down();
    const c = client();
    await c.variation('k', { profileId: 'x' }, 'd');
    await expect(c.variation('k', { userId: 'x' }, 'd')).resolves.toBe('d');
    await c.close();
  });

  it('keys and ids containing separators cannot collide', async () => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'a', value: 'first', reason: 'targeted' });
    down();
    const c = client();
    await c.variation('a', { userId: 'b","c' }, 'd');
    await expect(c.variation('a', { userId: 'b' }, 'd')).resolves.toBe('d');
    await c.close();
  });

  it('a different client keeps its own cache', async () => {
    served('blue');
    down();
    const a = client();
    const b = client();
    await a.variation('k', user, 'grey');
    await expect(b.variation('k', user, 'grey')).resolves.toBe('grey');
    await a.close();
    await b.close();
  });
});

describe('bounded at 10,000 entries', () => {
  it('is 10,000 entries for 24 h', () => {
    expect(CACHE_MAX).toBe(10_000);
    expect(CACHE_TTL_MS).toBe(DAY);
  });

  it('drops the oldest entry, not the newest, and a refresh makes an entry new again', async () => {
    const config = resolveConfig({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: HOST,
      logger: testLogger(),
    });
    const transport = new Transport(config, new ApiKeyCredentials(API_KEY));
    const flags = new Flags({
      transport,
      config: () => config,
      keyPrefix: 'pfx',
      cacheMax: 2,
    });
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .times(4)
      .reply(200, { key: 'k', value: 'v', reason: 'targeted' });
    await flags.value('k', { userId: 'a' }, 'd');
    await flags.value('k', { userId: 'b' }, 'd');
    await flags.value('k', { userId: 'a' }, 'd'); // a is now the newest
    await flags.value('k', { userId: 'c' }, 'd'); // evicts b
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).times(3).reply(503, {});
    await expect(flags.value('k', { userId: 'b' }, 'd')).resolves.toBe('d');
    await expect(flags.value('k', { userId: 'a' }, 'd')).resolves.toBe('v');
    await expect(flags.value('k', { userId: 'c' }, 'd')).resolves.toBe('v');
    transport.destroy();
  });
});
