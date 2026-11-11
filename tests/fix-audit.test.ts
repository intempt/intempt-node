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
 * Adversarial pass over the thirteen fixes themselves. A fix pass earns its own
 * audit: each of these attacks the new behaviour rather than the old defect.
 */

describe('audit the optOut gate in send()', () => {
  it('does not strand the buffer forever after optIn', async () => {
    // The gate discards on flush while opted out. If it left the queue in place
    // instead, a later optIn would resend data the user had revoked; if it left
    // the batcher stopped, nothing would ever send again.
    const logger = testLogger();
    const c = client({
      logger,
      batch: { size: 100, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });

    await c.track('before', { userId: 'u1' });
    c.optOut();
    await c.flush();
    expect(c.buffered).toBe(0);

    c.optIn();
    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    await c.track('after', { userId: 'u1' });
    await c.flush();

    expect(scope.isDone()).toBe(true);
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('discards rather than counting a failure when opted out', async () => {
    // send() returning early must not look like a delivery failure: nothing is
    // dropped or reported for an opt-out discard.
    const logger = testLogger();
    // size 1 means each track() triggers an immediate flush while still opted in,
    // so those sends need interceptors.
    nock(ORIGIN).post(TRACK_PATH).times(8).reply(200, '');
    const c = client({
      logger,
      batch: { size: 1, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });
    c.optIn();
    for (let i = 0; i < 8; i += 1) {
      await c.track(`e${i}`, { userId: 'u1' });
      c.optOut();
      await c.flush();
      c.optIn();
    }
    expect(logger.calls.error).toEqual([]);
    await c.close();
  });
});

describe('audit the closed-client throw', () => {
  it('keeps close() itself idempotent and non-throwing', async () => {
    const c = client();
    await c.close();
    await expect(c.close()).resolves.toEqual({ sent: 0, failed: 0 });
    await expect(c.flush()).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('gates the read path after close, like every other method', async () => {
    // This test used to assert the opposite — that recommend() still worked after
    // close() — on the reasoning that a read is harmless. It is not: close()
    // destroys the agents, and Agent.destroy() reaps only *idle* sockets, so the
    // call opened a fresh socket nothing would ever release. It also contradicted
    // the documented close() contract. The gate is the consistent choice.
    const c = client();
    await c.close();
    // An interceptor is registered on purpose: if the guard were missing, the call
    // would consume it, and the assertion that it is still pending is what proves
    // no request left the process. Asserting `pendingMocks()` is empty would have
    // been vacuous here — no interceptor, and setupNock's afterEach cleans them
    // anyway, so it reads as `[]` regardless of what the SDK does.
    const scope = nock(ORIGIN).post(feedPath('f')).reply(200, {});
    await expect(
      c.recommend({ userId: 'u1', feedId: 'f', fields: ['id'] }),
    ).rejects.toThrow(/client is closed/);
    expect(scope.isDone()).toBe(false);
    expect(nock.pendingMocks()).toHaveLength(1);
    nock.cleanAll();
  });

  it('throws synchronously enough to be catchable with await', async () => {
    const c = client();
    await c.close();
    let caught: unknown;
    try {
      await c.track('a', { userId: 'u' });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/client is closed/);
  });
});

describe('audit the blank-identifier rejections', () => {
  it('still accepts identifiers with meaningful internal whitespace', async () => {
    // Trimming for emptiness must not reject a legitimate id that contains a
    // space, and must not silently trim the value that is sent.
    let body: { track: Array<{ payload: Array<Record<string, unknown>> }> } | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH, (b) => {
        body = b as typeof body;
        return true;
      })
      .reply(200, '');

    await client().group({ userId: 'ada lovelace', accountId: 'acme corp' });

    const item = body!.track[0]!.payload[0]!;
    expect(item.userId).toBe('ada lovelace');
    expect(item.accountId).toBe('acme corp');
  });

  it('rejects tabs and newlines, not just spaces', async () => {
    await expect(client().consent.grant({ userId: '\t\n ' })).rejects.toThrow(
      /non-empty string/,
    );
  });
});

describe('audit the frozen config snapshot', () => {
  it('still reflects a later setConfig rather than caching a stale copy', () => {
    const c = client();
    expect(c.config.timeout).toBe(10_000);
    c.setConfig({ timeout: 1_234 });
    expect(c.config.timeout).toBe(1_234);
  });

  it('freezing batch does not break the batcher that shares those values', async () => {
    const c = client({
      batch: { size: 2, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });
    // Read the snapshot first: if freezing had frozen the batcher's own options,
    // a drain that touched them would now throw.
    void c.config.batch;
    // One request, dropped on 413 without halving (INT-7436).
    nock(ORIGIN).post(TRACK_PATH).reply(413, '');
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await expect(c.flush()).resolves.toEqual({ sent: 0, failed: 2 });
    await c.close();
  });
});

describe('audit the setConfig rejections', () => {
  it('rejects only the fixed keys, and still accepts the rest', () => {
    const c = client();
    expect(() => c.setConfig({ timeout: 5_000, debug: true, path: '/gw' })).not.toThrow();
    expect(c.config.path).toBe('/gw');
  });

  it('does not reject an explicit undefined, which means "leave it alone"', () => {
    const c = client();
    expect(() => c.setConfig({ keepAlive: undefined } as never)).not.toThrow();
  });
});

describe('audit destroy() with a proxy configured', () => {
  it('is still idempotent and does not throw twice', async () => {
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
      await c.close();
      await expect(c.close()).resolves.toEqual({ sent: 0, failed: 0 });
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });
});
