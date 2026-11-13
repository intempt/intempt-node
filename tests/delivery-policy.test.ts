import { describe, expect, it } from 'vitest';
import { ORIGIN, TRACK_PATH, client, nock, setupNock, testLogger } from './helpers';

setupNock();

/**
 * INT-7436, CONTRACT-R2 §S1: send once; 429/503 resend once after Retry-After clamped to [1 s, 60 s]
 * (1 s when absent), dropped past the 5 s server cap; every other answered status, and a timeout
 * after write, drops; never-reached keeps the batch (batch mode) or drops it (direct mode). Nothing
 * rejects to the caller for a delivery failure.
 */

interface WireBody {
  track: Array<{ name: string }>;
}

type Reply = number | { status: number; headers?: Record<string, string> } | 'refused';

/** One interceptor per reply, in order; records the event names of every attempt. */
function server(replies: Reply[]): string[][] {
  const attempts: string[][] = [];
  for (const reply of replies) {
    const scope = nock(ORIGIN).post(TRACK_PATH, (body: WireBody) => {
      attempts.push(body.track.map((e) => e.name));
      return true;
    });
    if (reply === 'refused') {
      scope.replyWithError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    } else if (typeof reply === 'number') {
      scope.reply(reply, '');
    } else {
      scope.reply(reply.status, '', reply.headers ?? {});
    }
  }
  return attempts;
}

function batched() {
  const logger = testLogger();
  const c = client({
    logger,
    batch: { size: 4, flushMs: 1, maxQueue: 100, flushOnExit: false },
  });
  return { c, logger };
}

async function trackAll(c: ReturnType<typeof client>, names: string[]): Promise<void> {
  for (const name of names) await c.track(name, { userId: 'u1' });
}

describe('batch mode: send once (INT-7436)', () => {
  it('drops a batch answered 500 after one attempt and delivers the next event alone', async () => {
    const attempts = server([500, 200]);
    const { c, logger } = batched();

    await trackAll(c, ['a']);
    await c.flush();
    await trackAll(c, ['b']);
    await c.flush();

    expect(attempts).toEqual([['a'], ['b']]);
    expect(c.buffered).toBe(0);
    expect(logger.calls.error.length).toBeGreaterThan(0);
  });

  it('drops a batch of 4 answered 413 after one attempt, without halving', async () => {
    const attempts = server([413]);
    const { c } = batched();

    await trackAll(c, ['a', 'b', 'c', 'd']);
    await c.flush();

    expect(attempts).toEqual([['a', 'b', 'c', 'd']]);
    expect(c.buffered).toBe(0);
  });

  it('drops a timed-out batch after one attempt: the server may already have it', async () => {
    nock(ORIGIN).post(TRACK_PATH).delay(200).reply(200, {});
    const extra = nock(ORIGIN).post(TRACK_PATH).reply(200, {});
    const logger = testLogger();
    const c = client({
      logger,
      timeout: 50,
      batch: { size: 4, flushMs: 1, maxQueue: 100, flushOnExit: false },
    });

    await trackAll(c, ['a']);
    await c.flush();

    expect(extra.isDone()).toBe(false);
    expect(c.buffered).toBe(0);
  });

  it('resends a 503 once, then drops on the second 503', async () => {
    const attempts = server([503, 503, 200]);
    const { c } = batched();

    await trackAll(c, ['a']);
    await c.flush();

    expect(attempts).toEqual([['a'], ['a']]);
    expect(c.buffered).toBe(0);
  });

  it('resends a 429 once and delivers when the resend succeeds', async () => {
    const attempts = server([{ status: 429, headers: { 'Retry-After': '1' } }, 200]);
    const { c } = batched();

    await trackAll(c, ['a']);
    await c.flush();

    expect(attempts).toEqual([['a'], ['a']]);
    expect(c.buffered).toBe(0);
  });

  it('drops instead of sleeping when Retry-After exceeds the 5 s server cap', async () => {
    const attempts = server([{ status: 503, headers: { 'Retry-After': '30' } }, 200]);
    const { c } = batched();

    const started = Date.now();
    await trackAll(c, ['a']);
    await c.flush();

    expect(attempts).toEqual([['a']]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(c.buffered).toBe(0);
  });

  it('keeps a batch that never reached the server, for the next flush', async () => {
    const attempts = server(['refused', 200]);
    const { c } = batched();

    await trackAll(c, ['a', 'b']);
    await c.flush();
    expect(c.buffered).toBe(2);

    await c.flush();
    expect(attempts).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    expect(c.buffered).toBe(0);
  });
});

describe('direct mode: send once, never reject (INT-7436)', () => {
  it('trackBatch answered 413 sends once and resolves', async () => {
    const attempts = server([413, 200, 200]);
    const c = client();

    await expect(
      c.trackBatch([
        { event: 'a', userId: 'u1' },
        { event: 'b', userId: 'u1' },
      ]),
    ).resolves.not.toThrow();
    expect(attempts).toEqual([['a', 'b']]);
  });

  it('track answered 500 sends once and resolves', async () => {
    const attempts = server([500, 200]);
    const logger = testLogger();
    const c = client({ logger });

    await expect(c.track('a', { userId: 'u1' })).resolves.not.toThrow();
    expect(attempts).toEqual([['a']]);
    expect(logger.calls.error.length).toBeGreaterThan(0);
  });

  it('track that never reached the server resolves and is reported', async () => {
    server(['refused']);
    const logger = testLogger();
    const c = client({ logger });

    await expect(c.track('a', { userId: 'u1' })).resolves.not.toThrow();
    expect(logger.calls.error.length).toBeGreaterThan(0);
  });

  it('consent answered 500 sends once and resolves (S1 covers consent)', async () => {
    let hits = 0;
    nock(ORIGIN)
      .post(/consents\/data/)
      .times(2)
      .reply(() => {
        hits += 1;
        return [500, ''];
      });
    const c = client();

    await expect(c.consent.grant({ userId: 'u1' })).resolves.toBe(false);
    expect(hits).toBe(1);
  });
});

/**
 * Ro-bot mcp-1794565555-8 impact:F1, ruling R4: a kept batch waits for the timed flush. Before
 * this, every enqueue that reached batch.size chained another drain, so each `track()` re-sent
 * the kept slice at an unreachable host, and the size-triggered drain also cancelled the timer.
 *
 * The interceptor is registered with a generous `.times()` and counts in its body matcher: nock's
 * blocked-net-connect error carries ENETUNREACH, which is never-reached, so an unmocked extra
 * attempt would masquerade as another kept batch instead of failing.
 */
describe('a kept batch waits for the next timed flush (R4)', () => {
  function unreachable(): { attempts: () => number } {
    let attempts = 0;
    nock(ORIGIN)
      .post(TRACK_PATH, () => {
        attempts += 1;
        return true;
      })
      .times(50)
      .replyWithError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    return { attempts: () => attempts };
  }

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function kept(flushMs: number) {
    const failures: Array<{ kind: string; eventCount: number }> = [];
    const c = client({
      logger: testLogger(),
      batch: { size: 2, flushMs, maxQueue: 100, flushOnExit: false },
      onDeliveryFailure: (f: { kind: string; eventCount: number }) => failures.push(f),
    } as never);
    return { c, failures };
  }

  it('track() makes no network attempt while a kept batch waits', async () => {
    const server = unreachable();
    const { c, failures } = kept(60_000);

    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await c.track(name, { userId: 'u1' });
    }
    await settle(50);

    expect(server.attempts()).toBe(1);
    expect(c.buffered).toBe(6);
    expect(failures.map((f) => [f.kind, f.eventCount])).toEqual([['transport', 2]]);

    nock.cleanAll();
    nock(ORIGIN).post(TRACK_PATH).times(3).reply(200, {});
    await expect(c.flush()).resolves.toEqual({ sent: 6, failed: 0 });
    await c.close();
  });

  it('the timed flush still resends the kept batch after size-triggered enqueues', async () => {
    const server = unreachable();
    const { c } = kept(40);

    for (const name of ['a', 'b', 'c', 'd']) {
      await c.track(name, { userId: 'u1' });
    }
    await settle(10);
    expect(server.attempts()).toBe(1);

    await settle(150);
    expect(server.attempts()).toBeGreaterThanOrEqual(2);
    expect(server.attempts()).toBeLessThanOrEqual(5);
    await c.close();
  });
});
