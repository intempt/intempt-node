import { afterEach, describe, expect, it } from 'vitest';
import {
  CHOOSE_PATH,
  FLAG_EVALUATE_PATH,
  ORIGIN,
  SOURCE,
  client,
  nock,
  setupNock,
  testLogger,
} from './helpers';
import { SDK } from '../src';

setupNock();

function capture(reply: unknown, status = 200) {
  const sent: Record<string, unknown>[] = [];
  nock(ORIGIN)
    .post(CHOOSE_PATH, (b) => {
      sent.push(b as Record<string, unknown>);
      return true;
    })
    .reply(status, reply as Record<string, unknown>);
  return sent;
}

describe('choose() request', () => {
  afterEach(() => nock.cleanAll());

  it('sends names, groups, sessionId, device and sourceId, and no exposure flag', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose(
      { userId: 'u-1', sessionId: 's-9' },
      { names: ['hero', 'promo_2'], groups: ['home'] },
    );
    await c.close();

    expect(sent).toEqual([
      {
        identification: { userId: 'u-1', sourceId: SOURCE },
        names: ['hero', 'promo_2'],
        groups: ['home'],
        device: 'all',
        sessionId: 's-9',
      },
    ]);
  });

  it('sends both ids and lets the server decide when profileId and userId are given', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose({ userId: 'u-1', profileId: 'p-1' }, { names: ['hero'] });
    await c.close();
    expect(sent[0]?.identification).toEqual({
      userId: 'u-1',
      profileId: 'p-1',
      sourceId: SOURCE,
    });
  });

  it('sends only userId when that is all there is', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    await c.close();
    expect(sent[0]?.identification).toEqual({ userId: 'u-1', sourceId: SOURCE });
  });

  it('accepts a profileId alone when a sourceId is configured', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose({ profileId: 'p-1' }, { names: ['hero'] });
    await c.close();
    expect(sent[0]?.identification).toEqual({ profileId: 'p-1', sourceId: SOURCE });
  });

  it('sends exposure:false only for disableExposure', async () => {
    const off = capture({ choices: [] });
    const c = client();
    await c.choose({ userId: 'u-1' }, { names: ['hero'], disableExposure: true });
    expect(off[0]?.exposure).toBe(false);

    const on = capture({ choices: [] });
    await c.choose({ userId: 'u-1' }, { names: ['hero'], disableExposure: false });
    expect(on[0]).not.toHaveProperty('exposure');

    const none = capture({ choices: [] });
    await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    expect(none[0]).not.toHaveProperty('exposure');
    await c.close();
  });

  it('omits names and groups when neither is given, and still sends the request', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose({ userId: 'u-1' });
    await c.close();
    expect(sent[0]).not.toHaveProperty('names');
    expect(sent[0]).not.toHaveProperty('groups');
    expect(sent[0]).toHaveProperty('device', 'all');
  });

  it('omits sessionId when absent', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    await c.close();
    expect(sent[0]).not.toHaveProperty('sessionId');
  });
});

describe('choose() reply', () => {
  afterEach(() => nock.cleanAll());

  it('parses the production reply of name, group and body only', async () => {
    capture({
      choices: [
        { name: 'hero', group: 'home', body: { title: 'Hi' } },
        { name: 'promo', body: '<b>x</b>' },
      ],
    });
    const c = client();
    const out = await c.choose({ userId: 'u-1' }, { names: ['hero', 'promo'] });
    await c.close();

    expect(out).toEqual([
      { name: 'hero', group: 'home', body: { title: 'Hi' } },
      { name: 'promo', body: '<b>x</b>' },
    ]);
    expect(out[0]).not.toHaveProperty('variantId');
    expect(out[0]).not.toHaveProperty('experienceId');
    expect(out[0]).not.toHaveProperty('reason');
  });

  it('keeps variantId, experienceId and reason when the server sends them', async () => {
    capture({
      choices: [
        {
          name: 'hero',
          group: 'home',
          body: 1,
          experienceId: 9220,
          variantId: 4,
          reason: 'assigned',
        },
      ],
      unserved: [{ name: 'other' }],
    });
    const c = client();
    const out = await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    await c.close();
    expect(out).toEqual([
      {
        name: 'hero',
        group: 'home',
        body: 1,
        experienceId: 9220,
        variantId: 4,
        reason: 'assigned',
      },
    ]);
  });

  it('ignores unserved', async () => {
    capture({ choices: [], unserved: [{ name: 'x' }] });
    const c = client();
    await expect(c.choose({ userId: 'u-1' }, { names: ['x'] })).resolves.toEqual([]);
    await c.close();
  });
});

describe('choose() failure resolves []', () => {
  afterEach(() => nock.cleanAll());

  it.each([500, 503, 429, 408])(
    'status %i resolves [] and warns once',
    async (status) => {
      capture({ error: 'x' }, status);
      const logger = testLogger();
      const c = client({ logger });
      await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
      expect(logger.calls.warn).toHaveLength(1);
      expect(logger.calls.error).toHaveLength(0);
      await c.close();
    },
  );

  it('a timeout resolves [] and warns, using the client timeout', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).delay(300).reply(200, { choices: [] });
    const logger = testLogger();
    const c = client({ logger, timeout: 50 });
    await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
    expect(logger.calls.warn).toHaveLength(1);
    await c.close();
  });

  it('a network error resolves [] and warns', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).replyWithError('boom');
    const logger = testLogger();
    const c = client({ logger });
    await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
    expect(logger.calls.warn).toHaveLength(1);
    await c.close();
  });

  it('non-JSON resolves [] and warns', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, '<html>nope</html>');
    const logger = testLogger();
    const c = client({ logger });
    await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
    expect(logger.calls.warn).toHaveLength(1);
    await c.close();
  });

  it.each([{}, { choices: 'x' }, { choices: null }, [], null])(
    'reply %j without a choices array resolves [] and warns',
    async (reply) => {
      nock(ORIGIN).post(CHOOSE_PATH).reply(200, JSON.stringify(reply));
      const logger = testLogger();
      const c = client({ logger });
      await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
      expect(logger.calls.warn).toHaveLength(1);
      await c.close();
    },
  );

  it.each([401, 403])('status %i resolves [] and logs at error', async (status) => {
    capture({ error: 'denied' }, status);
    const logger = testLogger();
    const c = client({ logger });
    await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
    expect(logger.calls.error).toHaveLength(1);
    expect(logger.calls.warn).toHaveLength(0);
    await c.close();
  });

  it('status 400 resolves [] and is logged', async () => {
    capture({ error: 'bad' }, 400);
    const logger = testLogger();
    const c = client({ logger });
    await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).resolves.toEqual([]);
    expect(logger.calls.warn.length + logger.calls.error.length).toBe(1);
    await c.close();
  });
});

describe('choose() validation rejects with TypeError', () => {
  afterEach(() => nock.cleanAll());

  it.each([
    [{}, 'empty context'],
    [{ userId: '   ' }, 'blank userId'],
    [{ profileId: '  ' }, 'blank profileId'],
    [{ sessionId: 's' }, 'sessionId alone'],
    [undefined, 'no context'],
  ])('no usable identity (%j: %s)', async (context, _label) => {
    const c = client();
    await expect(c.choose(context as never, { names: ['hero'] })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(nock.pendingMocks()).toEqual([]);
    await c.close();
  });

  it('profileId without a configured sourceId is not an identity', async () => {
    const c = client({ sourceId: undefined });
    await expect(
      c.choose({ profileId: 'p-1' }, { names: ['hero'] }),
    ).rejects.toBeInstanceOf(TypeError);
    await c.close();
  });

  it('userId alone is enough without a sourceId', async () => {
    const sent: unknown[] = [];
    nock(ORIGIN)
      .post(CHOOSE_PATH, (b) => {
        sent.push(b);
        return true;
      })
      .reply(200, { choices: [] });
    const c = client({ sourceId: undefined });
    await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    expect(sent).toHaveLength(1);
    await c.close();
  });

  it.each(['bad name', 'a.b', '', 'x/y', 'é'])('name %j is rejected', async (name) => {
    const c = client();
    await expect(c.choose({ userId: 'u-1' }, { names: [name] })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(nock.pendingMocks()).toEqual([]);
    await c.close();
  });

  it.each(['bad group', 'a,b', ''])('group %j is rejected', async (group) => {
    const c = client();
    await expect(c.choose({ userId: 'u-1' }, { groups: [group] })).rejects.toBeInstanceOf(
      TypeError,
    );
    await c.close();
  });

  it('accepts letters, digits, underscore and hyphen', async () => {
    capture({ choices: [] });
    const c = client();
    await expect(
      c.choose({ userId: 'u-1' }, { names: ['Aa09_-'], groups: ['G_1-x'] }),
    ).resolves.toEqual([]);
    await c.close();
  });

  it('allows names and groups together', async () => {
    const sent = capture({ choices: [] });
    const c = client();
    await c.choose({ userId: 'u-1' }, { names: ['a'], groups: ['b'] });
    expect(sent).toHaveLength(1);
    await c.close();
  });

  it('rejects on a closed client', async () => {
    const c = client();
    await c.close();
    await expect(c.choose({ userId: 'u-1' }, { names: ['hero'] })).rejects.toThrow();
  });
});

describe('choose() messages', () => {
  afterEach(() => nock.cleanAll());

  it('names the identity requirement, for an empty and for an absent context', async () => {
    const c = client();
    const want =
      /^choose: context needs either userId, or profileId together with a sourceId/;
    await expect(c.choose({}, { names: ['a'] })).rejects.toThrow(want);
    await expect(c.choose(undefined as never, { names: ['a'] })).rejects.toThrow(want);
    await c.close();
  });

  it('names the field and the offending value for a bad entry', async () => {
    const c = client();
    await expect(c.choose({ userId: 'u' }, { names: ['bad name'] })).rejects.toThrow(
      /^choose: names entries must match .*"bad name"/,
    );
    await expect(c.choose({ userId: 'u' }, { groups: ['x y'] })).rejects.toThrow(
      /^choose: groups entries must match .*"x y"/,
    );
    await c.close();
  });

  it('rejects a non-string entry and a non-array list', async () => {
    const c = client();
    await expect(c.choose({ userId: 'u' }, { names: [5] as never })).rejects.toThrow(
      /^choose: names entries must match/,
    );
    await expect(c.choose({ userId: 'u' }, { names: 'hero' as never })).rejects.toThrow(
      /^choose: names must be an array of strings$/,
    );
    await expect(c.choose({ userId: 'u' }, { groups: {} as never })).rejects.toThrow(
      /^choose: groups must be an array of strings$/,
    );
    await c.close();
  });

  it('logs the cause of a failed request', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, { error: 'x' });
    const logger = testLogger();
    const c = client({ logger });
    await c.choose({ userId: 'u' }, { names: ['a'] });
    expect(String(logger.calls.warn[0]?.[0])).toMatch(
      /^\[intempt\] choose: request failed, returning no choices \(Intempt API responded 500\)$/,
    );
    await c.close();
  });

  it('logs a reply without choices', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, {});
    const logger = testLogger();
    const c = client({ logger });
    await c.choose({ userId: 'u' }, { names: ['a'] });
    expect(logger.calls.warn[0]).toEqual([
      '[intempt] choose: reply has no choices array, returning no choices',
    ]);
    await c.close();
  });

  it('skips a choice without a string name', async () => {
    capture({ choices: [{ body: 1 }, null, { name: 7 }, { name: 'ok', body: 2 }] });
    const c = client();
    await expect(c.choose({ userId: 'u' }, { names: ['ok'] })).resolves.toEqual([
      { name: 'ok', body: 2 },
    ]);
    await c.close();
  });
});

describe('one client, two routes', () => {
  afterEach(() => nock.cleanAll());

  it('variation() hits only /flags/evaluate and choose() only choose-api', async () => {
    const evaluate = nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'f', value: true });
    const choose = nock(ORIGIN).post(CHOOSE_PATH).reply(200, { choices: [] });
    const c = client();

    await c.variation('f', { userId: 'u-1' }, false);
    expect(evaluate.isDone()).toBe(true);
    expect(choose.isDone()).toBe(false);

    await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    expect(choose.isDone()).toBe(true);
    await c.close();
  });
});

describe('legacy choose helpers point at choose()', () => {
  it.each([
    'chooseExperimentsByGroups',
    'chooseExperimentsByNames',
    'choosePersonalizationsByGroups',
    'choosePersonalizationsByNames',
  ] as const)('%s names choose()', (method) => {
    const sdk = new SDK('acme', 'web', 'pfx0123456789abcdef.sec0123456789abcdef', SOURCE);
    expect(() => sdk[method]()).toThrow(/choose\(context, \{ names \| groups \}\)/);
    expect(() => sdk[method]()).toThrow(/variation\(key, context, defaultValue\)/);
    expect(() => sdk[method]()).toThrow(/ for flags\.$/);
    void sdk.close();
  });
});
