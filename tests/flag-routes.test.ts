import { afterEach, describe, expect, it } from 'vitest';
import {
  CHOOSE_PATH,
  FLAG_ALL_PATH,
  FLAG_EVALUATE_PATH,
  ORIGIN,
  SOURCE,
  client,
  nock,
  setupNock,
} from './helpers';
import { IntemptFlags } from '../src/flags';
import { API_KEY, HOST, ORG, PROJECT, testLogger } from './helpers';

setupNock();

/**
 * F32/F33: flags are read from audience-service's flag routes, never from choose-api.
 * `/flags/evaluate` takes exactly one key and records the exposure on the server; `/flags/all`
 * publishes nothing (FlagEvaluateRequest / FlagAllRequest / FlagValue at audience-service 358d07d).
 */
const ctx = { userId: 'u-1' };

function capture(path: string, reply: unknown, status = 200) {
  const sent: Record<string, unknown>[] = [];
  nock(ORIGIN)
    .post(path, (b) => {
      sent.push(b as Record<string, unknown>);
      return true;
    })
    .reply(status, reply as Record<string, unknown>);
  return sent;
}

describe('variation reads /flags/evaluate', () => {
  afterEach(() => nock.cleanAll());

  it('sends one key, the identification and the device, and nothing else', async () => {
    const sent = capture(FLAG_EVALUATE_PATH, {
      key: 'new_checkout',
      value: true,
      variationId: 7,
      valueType: 'boolean',
      reason: 'targeted',
    });
    const c = client();
    await expect(c.variation('new_checkout', ctx, false)).resolves.toBe(true);
    await c.close();

    expect(sent).toEqual([
      {
        identification: { userId: 'u-1', sourceId: SOURCE },
        key: 'new_checkout',
        device: 'all',
      },
    ]);
  });

  it('never sends sessionId: the flag routes have no such field (F32)', async () => {
    const sent = capture(FLAG_EVALUATE_PATH, { key: 'k', value: 1 });
    const c = client();
    await c.variation('k', { userId: 'u-1', sessionId: 's-1' }, 0);
    await c.close();
    expect(sent[0]).not.toHaveProperty('sessionId');
  });

  it('returns the default when nothing was served (value null)', async () => {
    capture(FLAG_EVALUATE_PATH, { key: 'k', value: null, reason: 'off' });
    const c = client();
    await expect(c.variation('k', ctx, 'code-default')).resolves.toBe('code-default');
    await c.close();
  });

  it('returns the default on 404 "Flag not found"', async () => {
    capture(FLAG_EVALUATE_PATH, { message: 'Flag not found' }, 404);
    const c = client();
    await expect(c.variation('gone', ctx, 'code-default')).resolves.toBe('code-default');
    await c.close();
  });

  it('never calls choose-api', async () => {
    const choose = nock(ORIGIN).post(CHOOSE_PATH).reply(200, { choices: [] });
    capture(FLAG_EVALUATE_PATH, { key: 'k', value: 'x' });
    const c = client();
    await c.variation('k', ctx, 'd');
    await c.close();
    expect(choose.isDone()).toBe(false);
  });
});

describe('disableExposure reads /flags/all with the one key, which publishes nothing', () => {
  afterEach(() => nock.cleanAll());

  it("sends keys: [key] and returns that key's value", async () => {
    const sent = capture(FLAG_ALL_PATH, {
      flags: [{ key: 'k', value: 'on', valueType: 'string', reason: 'targeted' }],
    });
    const c = client();
    await expect(c.variation('k', ctx, 'off', { disableExposure: true })).resolves.toBe(
      'on',
    );
    await c.close();
    expect(sent).toEqual([
      { identification: { userId: 'u-1', sourceId: SOURCE }, keys: ['k'], device: 'all' },
    ]);
  });

  it('returns the default when the key is absent from the answer', async () => {
    capture(FLAG_ALL_PATH, { flags: [{ key: 'other', value: 'x' }] });
    const c = client();
    await expect(c.variation('k', ctx, 'd', { disableExposure: true })).resolves.toBe(
      'd',
    );
    await c.close();
  });
});

describe('allFlags reads /flags/all without keys', () => {
  afterEach(() => nock.cleanAll());

  it('sends no keys and maps the answer key -> value', async () => {
    const sent = capture(FLAG_ALL_PATH, {
      flags: [
        { key: 'a', value: 'x', valueType: 'string', reason: 'targeted' },
        { key: 'b', value: { n: 1 }, valueType: 'json', reason: 'targeted' },
      ],
    });
    const c = client();
    await expect(c.allFlags(ctx)).resolves.toEqual({ a: 'x', b: { n: 1 } });
    await c.close();
    expect(sent).toEqual([
      { identification: { userId: 'u-1', sourceId: SOURCE }, device: 'all' },
    ]);
  });
});

describe('the flags-only client (intempt-nodejs-sdk/flags)', () => {
  afterEach(() => nock.cleanAll());

  it('serves a flag with its own transport and no tracking surface', async () => {
    capture(FLAG_EVALUATE_PATH, { key: 'k', value: 42, valueType: 'number' });
    const flags = IntemptFlags.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: HOST,
      logger: testLogger(),
    });
    await expect(flags.numberVariation('k', ctx, 0)).resolves.toBe(42);
    expect('track' in flags).toBe(false);
    await flags.close();
    await expect(flags.variation('k', ctx, 0)).rejects.toThrow(/closed/);
  });
});

describe('every flags-only client method reaches the flag module', () => {
  afterEach(() => nock.cleanAll());

  function flagsClient() {
    return IntemptFlags.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: HOST,
      logger: testLogger(),
    });
  }

  it.each([
    ['variation', 'x', 'd', 'x'],
    [
      'variationDetail',
      'x',
      'd',
      { value: 'x', reason: 'targeted', valueType: 'string' },
    ],
    ['stringVariation', 'x', 'd', 'x'],
    ['numberVariation', 3, 0, 3],
    ['boolVariation', true, false, true],
    ['jsonVariation', [1], [], [1]],
  ] as const)('%s', async (method, value, dflt, want) => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, {
        key: 'k',
        value,
        valueType: Array.isArray(value) ? 'json' : typeof value,
        reason: 'targeted',
      });
    const flags = flagsClient();
    const call = flags[method] as (
      k: string,
      c: typeof ctx,
      d: unknown,
    ) => Promise<unknown>;
    await expect(call.call(flags, 'k', ctx, dflt)).resolves.toEqual(want);
    await flags.close();
    await expect(call.call(flags, 'k', ctx, dflt)).rejects.toThrow(
      /flags client is closed/,
    );
  });

  it('allFlags, and refuses it after close', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, { flags: [{ key: 'a', value: 1 }] });
    const flags = flagsClient();
    await expect(flags.allFlags(ctx)).resolves.toEqual({ a: 1 });
    await flags.close();
    await expect(flags.allFlags(ctx)).rejects.toThrow(/closed/);
  });
});

describe('IntemptClient refuses every flag call after close()', () => {
  // Each typed call guards itself now that it no longer goes through variation(): a call after
  // close() would otherwise open a socket that nothing releases (see recommend()).
  it.each([
    ['variation', 'd'],
    ['variationDetail', 'd'],
    ['boolVariation', false],
    ['stringVariation', 'd'],
    ['numberVariation', 0],
    ['jsonVariation', {}],
  ] as const)('%s', async (method, dflt) => {
    const c = client();
    await c.close();
    const call = c[method] as (k: string, x: typeof ctx, d: unknown) => Promise<unknown>;
    await expect(call.call(c, 'k', ctx, dflt)).rejects.toThrow(/client is closed/);
  });

  it('allFlags', async () => {
    const c = client();
    await c.close();
    await expect(c.allFlags(ctx)).rejects.toThrow(/client is closed/);
  });
});
