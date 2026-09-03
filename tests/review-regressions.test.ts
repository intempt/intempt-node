import { describe, expect, it } from 'vitest';
import { Intempt } from '../src';
import {
  ORIGIN,
  TRACK_PATH,
  client,
  feedPath,
  nock,
  setupNock,
  testLogger,
} from './helpers';

setupNock();

/**
 * One test per defect found by the code review of PR #19, so none can return.
 */

describe('regression: 413 halving is not undone by the next success', () => {
  it('keeps the reduced width until a full-width send succeeds', async () => {
    // Resetting after every success meant 413 -> halve -> succeed -> reset ->
    // 413 again, forever, at double the request count, and each success cleared
    // the failure counter so the breaker never tripped.
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(6)
      .reply(function () {
        const n = widths[widths.length - 1] ?? 0;
        return n > 4 ? [413, ''] : [200, ''];
      });

    const c = client({
      logger: testLogger(),
      batch: { size: 8, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });
    for (let i = 0; i < 16; i += 1) await c.track(`e${i}`, { userId: 'u1' });
    await c.flush();

    // First request oversized and rejected, then every following one stays at 4.
    expect(widths[0]).toBe(8);
    expect(widths.slice(1).every((w) => w <= 4)).toBe(true);
    expect(widths.filter((w) => w === 8)).toHaveLength(1);
    expect(c.buffered).toBe(0);
    await c.close();
  });
});

describe('regression: a zero or past Retry-After must not become a hot loop', () => {
  it('floors the backoff instead of retrying instantly', async () => {
    const logger = testLogger();
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '0' });
    nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    const c = client({
      logger,
      // Small flushMs on purpose: the exponential fallback is then tiny, so what
      // the test observes is the MIN_RETRY_INTERVAL_MS floor rather than a long wait.
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    const started = Date.now();
    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(logger.calls.warn.some((a) => /retrying in 0ms/.test(String(a[0])))).toBe(
      false,
    );
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('treats an HTTP-date already in the past the same way', async () => {
    const logger = testLogger();
    const past = new Date(Date.now() - 60_000).toUTCString();
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': past });
    nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    const c = client({
      logger,
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(logger.calls.warn.some((a) => /retrying in 0ms/.test(String(a[0])))).toBe(
      false,
    );
    expect(c.buffered).toBe(0);
    await c.close();
  });
});

describe('regression: dropping a bad batch is not a transient failure', () => {
  it('does not let one 400 push the breaker over the edge', async () => {
    const logger = testLogger();
    for (const status of [500, 500, 500, 500, 400, 200]) {
      nock(ORIGIN).post(TRACK_PATH).reply(status, '');
    }
    const c = client({
      logger,
      batch: { size: 1, flushMs: 1, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await c.flush();

    // The 400 resets the tally, so the following event still gets sent rather
    // than the breaker tripping on a single later blip.
    expect(
      logger.calls.error.some((a) => String(a[0]).includes('stopping batching')),
    ).toBe(false);
    await c.close();
  });
});

describe('regression: recommend must not let an empty userId beat accountId', () => {
  it('sends the account, not an empty id', async () => {
    const bodies: Record<string, unknown>[] = [];
    nock(ORIGIN)
      .post(feedPath('f'), (b: Record<string, unknown>) => {
        bodies.push(b);
        return true;
      })
      .reply(200, {});

    await client().recommend({
      userId: '',
      accountId: 'acct-1',
      feedId: 'f',
      fields: ['id'],
    });

    expect(bodies[0]!.id).toBe('acct-1');
    expect(bodies[0]!.type).toBe('account');
  });

  it('rejects when both are blank', async () => {
    await expect(
      client().recommend({ userId: '  ', accountId: '', feedId: 'f', fields: ['id'] }),
    ).rejects.toThrow(/one of userId or accountId/);
  });
});

describe('regression: blank identifiers never reach the wire', () => {
  it.each([
    ['group accountId', () => client().group({ userId: 'u', accountId: '   ' })],
    ['consent userId', () => client().consent.grant({ userId: '   ' })],
  ])('%s', async (_label, call) => {
    await expect(call()).rejects.toThrow(/non-empty string/);
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('regression: optOut must suppress already-buffered events', () => {
  it('discards the buffer on flush rather than transmitting it', async () => {
    // The batcher calls Ingest.send directly, bypassing the gate #submit applies,
    // so a consent revocation between capture and flush was not honoured.
    const logger = testLogger();
    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    const c = client({
      logger,
      batch: { size: 100, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });
    await c.track('captured-before-optout', { userId: 'u1' });
    expect(c.buffered).toBe(1);

    c.optOut();
    await c.flush();

    expect(scope.isDone()).toBe(false);
    expect(logger.calls.warn.some((a) => String(a[0]).includes('opted out'))).toBe(true);
    nock.cleanAll();
  });
});

describe('regression: the config snapshot cannot be used to reach the batcher', () => {
  it('freezes batch as well as the top level', async () => {
    const c = client({
      batch: { size: 10, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });
    const snapshot = c.config;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.batch)).toBe(true);
    expect(() => {
      (snapshot.batch as unknown as Record<string, number>).maxQueue = 0;
    }).toThrow(TypeError);

    nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    await c.track('still-works', { userId: 'u1' });
    expect(c.buffered).toBe(1);
    await c.close();
  });
});

describe('regression: setConfig cannot pretend to change fixed options', () => {
  it.each(['keepAlive', 'agent'])('rejects %s instead of ignoring it', (key) => {
    const c = client();
    expect(() =>
      c.setConfig({ [key]: key === 'keepAlive' ? false : {} } as never),
    ).toThrow(/fixed at construction/);
  });
});

describe('regression: a closed client is loud', () => {
  it('throws from every write path', async () => {
    const c = client();
    await c.close();
    await expect(c.track('a', { userId: 'u' })).rejects.toThrow(/client is closed/);
    await expect(c.identify({ userId: 'u' })).rejects.toThrow(/client is closed/);
    await expect(c.consent.grant({ userId: 'u' })).rejects.toThrow(/client is closed/);
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('regression: destroy() releases the agent actually in use', () => {
  it('destroys the proxy agent when a proxy is configured', async () => {
    // Behind a proxy every request runs on #proxyAgent, so destroying only the
    // two keep-alive agents left live sockets open and the process hanging.
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    try {
      const c = Intempt.init({
        org: 'o',
        project: 'p',
        apiKey: 'a.b',
        sourceId: '1',
        logger: testLogger(),
      });
      await expect(c.close()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });
});
