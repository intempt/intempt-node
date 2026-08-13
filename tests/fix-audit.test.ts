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
  waitFor,
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
    // send() returning early must not look like a transient failure, or repeated
    // opt-out flushes would trip the circuit breaker.
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
    expect(
      logger.calls.error.some((a) => String(a[0]).includes('stopping batching')),
    ).toBe(false);
    await c.close();
  });
});

describe('audit the closed-client throw', () => {
  it('keeps close() itself idempotent and non-throwing', async () => {
    const c = client();
    await c.close();
    await expect(c.close()).resolves.toBeUndefined();
    await expect(c.flush()).resolves.toBeUndefined();
  });

  it('leaves read paths usable after close rather than half-breaking', async () => {
    // recommend() is a read and was never gated by optOut, so closing must not
    // change it into a throw by accident. Whatever the choice, it must be
    // consistent, not accidental.
    const c = client();
    await c.close();
    const scope = nock(ORIGIN).post(feedPath('f')).reply(200, {});
    await expect(
      c.recommend({ userId: 'u1', feedId: 'f', fields: ['id'] }),
    ).resolves.toEqual({});
    scope.done();
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

describe('audit the 413 width policy', () => {
  // Recovery of the full width is asserted in tests/boundaries.test.ts, which
  // counts width-4 requests before and after the 413. This test only proves the
  // narrower property that a 413 does not lose events.
  //
  // It used to be titled "recovers full width…" and asserted `widths` contained a
  // 4 — which the rejected pre-413 attempt already satisfied, so it passed while
  // the width in fact stayed halved for the life of the client. Mutation testing
  // caught the vacuous assertion.
  it('drains the queue through a 413 without losing events', async () => {
    const widths: number[] = [];
    let rejectBig = true;
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(8)
      .reply(function () {
        const n = widths[widths.length - 1] ?? 0;
        return rejectBig && n > 2 ? [413, ''] : [200, ''];
      });

    const c = client({
      logger: testLogger(),
      batch: { size: 4, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });
    for (let i = 0; i < 4; i += 1) await c.track(`a${i}`, { userId: 'u1' });
    await c.flush();
    expect(c.buffered).toBe(0);

    // Server healthy again: everything queued after the 413 still gets sent.
    rejectBig = false;
    for (let i = 0; i < 4; i += 1) await c.track(`b${i}`, { userId: 'u1' });
    await c.flush();

    // 4 rejected + 4 accepted + 4 more = every event accounted for, counting the
    // rejected attempt once.
    const accepted = widths.slice(1).reduce((a, b) => a + b, 0);
    expect(accepted).toBe(8);
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('does not divide below one and spin', async () => {
    const logger = testLogger();
    nock(ORIGIN).post(TRACK_PATH).times(4).reply(413, '');
    const c = client({
      logger,
      batch: { size: 2, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await c.flush();

    // Halve to 1, then drop each single event; the queue must empty, not spin.
    expect(c.buffered).toBe(0);
    expect(
      logger.calls.error.some((a) => String(a[0]).includes('single event too large')),
    ).toBe(true);
    await c.close();
  });
});

describe('audit the retry floor', () => {
  it('still honours a genuinely long Retry-After rather than flooring it down', async () => {
    // The floor must be a lower bound only. Clamping a long wait down would
    // ignore a server asking for real relief.
    const logger = testLogger();
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '2' });
    nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    const c = client({
      logger,
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    const flushing = c.flush();

    // Wait for the backoff decision to be logged, then assert what it chose.
    await waitFor(() =>
      logger.calls.warn.some((a) => /retrying in \d+ms/.test(String(a[0]))),
    );
    expect(logger.calls.warn.some((a) => /retrying in 2000ms/.test(String(a[0])))).toBe(
      true,
    );
    await flushing;
    await c.close();
  }, 10_000);

  it('caps a hostile multi-year Retry-After at the maximum interval', async () => {
    const logger = testLogger();
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '999999999' });
    const c = client({
      logger,
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    void c.flush();
    await waitFor(() =>
      logger.calls.warn.some((a) => /retrying in \d+ms/.test(String(a[0]))),
    );

    const advised = logger.calls.warn
      .map((a) => /retrying in (\d+)ms/.exec(String(a[0]))?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(advised[0]).toBeLessThanOrEqual(10 * 60 * 1000);
    nock.cleanAll();
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
    // its internal width adjustments would now throw.
    void c.config.batch;
    // width 2 -> 413, halve to 1, then one 413 per single event: three requests.
    nock(ORIGIN).post(TRACK_PATH).times(4).reply(413, '');
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await expect(c.flush()).resolves.toBeUndefined();
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
      await expect(c.close()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });
});
