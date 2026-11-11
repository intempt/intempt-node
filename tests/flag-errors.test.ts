import { afterEach, describe, expect, it } from 'vitest';
import {
  CHOOSE_PATH,
  ORIGIN,
  SOURCE,
  client,
  nock,
  setupNock,
  testLogger,
} from './helpers';
import type { FlagError } from '../src';

setupNock();

/**
 * INT-7454 (CONTRACT-R2 §S3): a flag read that fails still returns the caller's default, and the
 * failure is now reported through `onFlagError` and `variationDetail` instead of one warn line
 * that made a revoked key indistinguishable from an unassigned one.
 *
 * Kinds mirror php and python: 408 is a timeout, 429 is the server's capacity, not the caller's
 * request.
 */
const ctx = { userId: 'u-1' };

function hooked() {
  const errors: FlagError[] = [];
  const logger = testLogger();
  const c = client({ logger, onFlagError: (e) => errors.push(e) });
  return { c, errors, logger };
}

describe('onFlagError classifies the failure and the default is still returned', () => {
  afterEach(() => nock.cleanAll());

  it.each([
    [400, 'bad_request'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'bad_request'],
    [408, 'timeout'],
    [429, 'server'],
    [499, 'bad_request'],
    [500, 'server'],
    [503, 'server'],
  ] as const)('status %i is kind %s', async (status, kind) => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(status, {});
    const { c, errors } = hooked();

    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    expect(errors).toEqual([{ key: 'k', kind, status }]);
    await c.close();
  });

  it('a request that timed out is kind timeout, with no status', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).delay(200).reply(200, { choices: [] });
    const errors: FlagError[] = [];
    const c = client({ timeout: 50, onFlagError: (e) => errors.push(e) });

    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    expect(errors).toEqual([{ key: 'k', kind: 'timeout' }]);
    await c.close();
  });

  it('a request that never reached the service is kind network', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .replyWithError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    const { c, errors } = hooked();

    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    expect(errors).toEqual([{ key: 'k', kind: 'network' }]);
    await c.close();
  });

  it.each([
    ['a non-JSON body', '<html>gateway</html>'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['choices that is not an array', '{"choices":"x"}'],
  ])('a 200 with %s is kind parse', async (_label, raw) => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, raw);
    const { c, errors } = hooked();

    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    expect(errors).toEqual([{ key: 'k', kind: 'parse' }]);
    await c.close();
  });

  it('a 200 with no choices field, or no choice for the key, is not an error', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, {});
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, { choices: [] });
    const { c, errors } = hooked();

    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    expect(errors).toEqual([]);
    await c.close();
  });

  it('allFlags reports with a null key and returns an empty map', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, {});
    const { c, errors } = hooked();

    await expect(c.allFlags(ctx)).resolves.toEqual({});
    expect(errors).toEqual([{ key: null, kind: 'server', status: 500 }]);
    await c.close();
  });

  it('a hook that throws is logged and the default is still returned', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, {});
    const logger = testLogger();
    const c = client({
      logger,
      onFlagError: () => {
        throw new Error('boom');
      },
    });

    await expect(c.variation('k', ctx, 'safe')).resolves.toBe('safe');
    expect(logger.calls.error.map((a) => String(a[0]))).toEqual([
      '[intempt] onFlagError listener threw',
    ]);
    await c.close();
  });

  it('a programming error still throws and never reaches the hook', async () => {
    const { c, errors } = hooked();

    await expect(c.variation('has.dot', ctx, 'd')).rejects.toThrow(TypeError);
    await expect(c.variation('k', {}, 'd')).rejects.toThrow(TypeError);
    expect(errors).toEqual([]);
    await c.close();
  });

  it('a non-function hook is refused at init and at setConfig', () => {
    expect(() => client({ onFlagError: 'x' as never })).toThrow(
      'onFlagError must be a function',
    );
    const c = client();
    expect(() => c.setConfig({ onFlagError: 1 as never })).toThrow(
      'onFlagError must be a function',
    );
  });

  it('setConfig replaces the hook, because flags read the config at call time', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, {});
    const first: FlagError[] = [];
    const second: FlagError[] = [];
    const c = client({ onFlagError: (e) => first.push(e) });
    c.setConfig({ onFlagError: (e) => second.push(e) });

    await c.variation('k', ctx, 'safe');
    expect(first).toEqual([]);
    expect(second).toEqual([{ key: 'k', kind: 'server', status: 500 }]);
    await c.close();
  });
});

describe('logging', () => {
  afterEach(() => nock.cleanAll());

  it('the first 401/403 is an error naming the key prefix and source, later ones are debug', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).times(3).reply(401, {});
    const { c, logger } = hooked();

    await c.variation('a', ctx, 0);
    await c.variation('b', ctx, 0);
    await c.allFlags(ctx);

    expect(logger.calls.error).toHaveLength(1);
    const first = String(logger.calls.error[0]?.[0]);
    expect(first).toContain('401');
    expect(first).toContain('pfx0123456789abcdef');
    expect(first).toContain(SOURCE);
    expect(
      logger.calls.debug.filter((a) => String(a[0]).includes('refused')),
    ).toHaveLength(2);
    expect(logger.calls.warn).toEqual([]);
    await c.close();
  });

  it('the latch is per client instance', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).times(2).reply(403, {});
    const a = hooked();
    const b = hooked();

    await a.c.variation('k', ctx, 0);
    await b.c.variation('k', ctx, 0);

    expect(a.logger.calls.error).toHaveLength(1);
    expect(b.logger.calls.error).toHaveLength(1);
    await a.c.close();
    await b.c.close();
  });

  it('never logs the secret half of the key', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(401, {});
    const { c, logger } = hooked();

    await c.variation('k', ctx, 0);

    const everything = JSON.stringify(Object.values(logger.calls).flat(2).map(String));
    expect(everything).not.toContain('sec0123456789abcdef');
    await c.close();
  });

  it('any other failure warns with its kind', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, {});
    const { c, logger } = hooked();

    await c.variation('k', ctx, 0);

    expect(String(logger.calls.warn[0]?.[0])).toBe(
      '[intempt] flag evaluation failed (server), using defaults',
    );
    expect(logger.calls.error).toEqual([]);
    await c.close();
  });
});

describe('variationDetail', () => {
  afterEach(() => nock.cleanAll());

  it("returns the default with reason 'error' and the error on a failure", async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(503, {});
    const c = client();

    await expect(c.variationDetail('k', ctx, 'safe')).resolves.toEqual({
      value: 'safe',
      reason: 'error',
      error: { key: 'k', kind: 'server', status: 503 },
    });
    await c.close();
  });

  it("a served value reads 'off' with no error: the platform sends no reason (INT-7457)", async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'k', body: 'on' }] });
    const c = client();

    const detail = await c.variationDetail('k', ctx, 'safe');
    expect(detail).toEqual({ value: 'on', reason: 'off' });
    expect('error' in detail).toBe(false);
    await c.close();
  });

  it("a 200 with no choice for the key reads 'off', not 'error'", async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, { choices: [] });
    const c = client();

    await expect(c.variationDetail('k', ctx, 'safe')).resolves.toEqual({
      value: 'safe',
      reason: 'off',
    });
    await c.close();
  });

  it('validates like variation and refuses a closed client', async () => {
    const c = client();
    await expect(c.variationDetail('has.dot', ctx, 'd')).rejects.toThrow(TypeError);
    await c.close();
    await expect(c.variationDetail('k', ctx, 'd')).rejects.toThrow(/closed/);
  });
});
