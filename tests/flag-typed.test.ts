import { afterEach, describe, expect, it } from 'vitest';
import { FLAG_EVALUATE_PATH, ORIGIN, client, nock, setupNock } from './helpers';

setupNock();

/**
 * F30: a typed read returns the caller's default on a type mismatch, with reason `error` and
 * errorCode `TYPE_MISMATCH` in the detail. The expected type comes from the default's type
 * (GrowthBook-style, no `*Detail` per type). It is checked against the server's declared
 * `valueType` when sent, else against the JavaScript type (older server, F6 #4).
 */
const ctx = { userId: 'u-1' };

function serve(body: Record<string, unknown>) {
  nock(ORIGIN)
    .post(FLAG_EVALUATE_PATH)
    .reply(200, { key: 'k', ...body });
}

describe('typed calls', () => {
  afterEach(() => nock.cleanAll());

  it.each([
    ['boolVariation', { value: true, valueType: 'boolean' }, false, true],
    ['stringVariation', { value: 'b', valueType: 'string' }, 'a', 'b'],
    ['numberVariation', { value: 0, valueType: 'number' }, 5, 0],
    ['jsonVariation', { value: { a: 1 }, valueType: 'json' }, {}, { a: 1 }],
    ['jsonVariation', { value: [1, 2], valueType: 'json' }, [], [1, 2]],
    ['jsonVariation', { value: 'scalar', valueType: 'json' }, {}, 'scalar'],
  ] as const)(
    '%s returns a value of the declared type',
    async (method, body, dflt, want) => {
      serve(body);
      const c = client();
      const call = c[method] as (
        k: string,
        x: typeof ctx,
        d: unknown,
      ) => Promise<unknown>;
      await expect(call.call(c, 'k', ctx, dflt)).resolves.toEqual(want);
      await c.close();
    },
  );

  it.each([
    ['boolVariation', { value: 'true', valueType: 'string' }, false],
    ['boolVariation', { value: true, valueType: 'string' }, false],
    ['stringVariation', { value: 1, valueType: 'number' }, 'a'],
    ['numberVariation', { value: '1', valueType: 'string' }, 5],
    ['numberVariation', { value: 1, valueType: 'json' }, 5],
    ['jsonVariation', { value: true, valueType: 'boolean' }, {}],
  ] as const)(
    '%s returns the default on a mismatch with %j',
    async (method, body, dflt) => {
      serve(body);
      const c = client();
      const call = c[method] as (
        k: string,
        x: typeof ctx,
        d: unknown,
      ) => Promise<unknown>;
      await expect(call.call(c, 'k', ctx, dflt)).resolves.toEqual(dflt);
      await c.close();
    },
  );

  it.each([
    ['boolVariation', { value: 'false' }, false],
    ['stringVariation', { value: 3 }, 'a'],
    ['numberVariation', { value: '3' }, 5],
    ['numberVariation', { value: 'NaN-ish' }, 5],
  ] as const)(
    'without a valueType (older server) %s checks the JavaScript type',
    async (method, body, dflt) => {
      serve(body);
      const c = client();
      const call = c[method] as (
        k: string,
        x: typeof ctx,
        d: unknown,
      ) => Promise<unknown>;
      await expect(call.call(c, 'k', ctx, dflt)).resolves.toEqual(dflt);
      await c.close();
    },
  );

  it('without a valueType jsonVariation accepts any JSON value', async () => {
    serve({ value: 'plain' });
    const c = client();
    await expect(c.jsonVariation('k', ctx, {})).resolves.toBe('plain');
    await c.close();
  });
});

describe('variationDetail takes the expected type from the default', () => {
  afterEach(() => nock.cleanAll());

  it('reports TYPE_MISMATCH with reason error and the default', async () => {
    serve({ value: 'on', variationId: 3, valueType: 'string', reason: 'targeted' });
    const c = client();
    await expect(c.variationDetail('k', ctx, false)).resolves.toEqual({
      value: false,
      reason: 'error',
      errorCode: 'TYPE_MISMATCH',
      variationId: 3,
      valueType: 'string',
    });
    await c.close();
  });

  it('boolVariation on a string flag reads the same in the detail (plan example)', async () => {
    serve({ value: 'on', valueType: 'string', reason: 'targeted' });
    const c = client();
    await expect(c.boolVariation('k', ctx, false)).resolves.toBe(false);
    await c.close();
  });

  it('an object or array default expects json', async () => {
    serve({ value: [1], valueType: 'json', reason: 'targeted' });
    serve({ value: 1, valueType: 'number', reason: 'targeted' });
    const c = client();
    await expect(c.variationDetail('k', ctx, [] as number[])).resolves.toMatchObject({
      value: [1],
      reason: 'targeted',
    });
    await expect(c.variationDetail('k', ctx, {})).resolves.toMatchObject({
      value: {},
      errorCode: 'TYPE_MISMATCH',
    });
    await c.close();
  });

  it('a null default expects no particular type', async () => {
    serve({ value: 'anything', valueType: 'string', reason: 'targeted' });
    const c = client();
    await expect(c.variationDetail<unknown>('k', ctx, null)).resolves.toEqual({
      value: 'anything',
      reason: 'targeted',
      valueType: 'string',
    });
    await c.close();
  });

  it('a matching type carries no errorCode', async () => {
    serve({ value: 2, valueType: 'number', reason: 'targeted' });
    const c = client();
    const detail = await c.variationDetail('k', ctx, 1);
    expect(detail).toEqual({ value: 2, reason: 'targeted', valueType: 'number' });
    expect('errorCode' in detail).toBe(false);
    await c.close();
  });
});
