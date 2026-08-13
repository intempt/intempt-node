import { describe, expect, it } from 'vitest';
import { IntemptApiError } from '../src';
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
 * Boundary assertions, each one derived from a mutant that survived the suite.
 *
 * A surviving mutant means some decision in the code can be rewritten without a
 * single test noticing, so these are the comparisons and thresholds nothing was
 * pinning: which statuses count as failures, how many attempts the breaker
 * allows, whether backoff grows or shrinks, and whether a reduced batch width
 * ever recovers.
 */

function batched(overrides: Record<string, unknown> = {}) {
  const logger = testLogger();
  return { logger, c: client({ logger, ...overrides }) };
}

/** Backoff intervals the batcher logged, in order. */
function backoffs(logger: ReturnType<typeof testLogger>): number[] {
  return logger.calls.warn
    .map((a) => /retrying in (\d+)ms/.exec(String(a[0]))?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
}

describe('which HTTP statuses count as a failure', () => {
  // 2xx is success and everything else is not. 300 is the upper edge and was
  // unasserted: `status >= 300` could become `> 300` with no test failing.
  //
  // The lower edge is not testable here. undici refuses to construct a response
  // below 200 ("init[\"status\"] must be in the range of 200 to 599"), and a real
  // 1xx never reaches this callback either — Node routes informational responses
  // to an `information` event. The `status < 200` arm exists for the `?? 0`
  // fallback when statusCode is absent, which is the unreachable-by-design guard
  // documented in src/transport.ts.
  it('treats 300 as an error, not a success', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(300, 'multiple choices');
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;
    expect(error).toBeInstanceOf(IntemptApiError);
    expect(error.status).toBe(300);
  });

  it.each([200, 204, 299])('treats %i as a success', async (status) => {
    nock(ORIGIN).post(TRACK_PATH).reply(status, '');
    await expect(client().track('purchase', { userId: 'u1' })).resolves.toBeUndefined();
  });
});

describe('the error carries only the fields the response actually had', () => {
  it('leaves retryAfterMs and cause undefined when there was neither', async () => {
    // Presence cannot be the signal: the target is ES2022, so every declared
    // field is an own property before the constructor body runs and
    // `'retryAfterMs' in error` is true even when no header was sent. The value
    // is the contract, so that is what this asserts.
    nock(ORIGIN).post(TRACK_PATH).reply(500, 'boom');
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    expect(error.retryAfterMs).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.status).toBe(500);
    expect(error.body).toBe('boom');
  });

  it('sets cause when the failure came from the socket', async () => {
    nock(ORIGIN)
      .post(TRACK_PATH)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    expect((error.cause as Error).message).toMatch(/socket hang up/);
    expect(error.status).toBeUndefined();
    // No status means "transport failure", which the batcher must treat as
    // retryable.
    expect(error.retryable).toBe(true);
  });

  it('records a Retry-After the server did send', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '3' });
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;
    expect(error.retryAfterMs).toBe(3000);
  });

  it('never turns a negative Retry-After into a negative wait', async () => {
    // `Number('-5')` is finite, so a check of finite-OR-non-negative would accept
    // it and return -5000. A negative wait means no wait at all.
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '-5' });
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;
    expect(error.retryAfterMs === undefined || error.retryAfterMs >= 0).toBe(true);
  });
});

describe('an empty success body is absent, not an empty string', () => {
  it('leaves body undefined rather than parsing ""', async () => {
    // Attempting JSON.parse('') throws, and the catch falls back to the raw
    // string, so dropping the length check turns "no body" into "".
    nock(ORIGIN).post(feedPath('f1')).reply(200, '');
    await expect(
      client().recommend({ userId: 'u1', feedId: 'f1', fields: ['id'] }),
    ).resolves.toBeUndefined();
  });

  it('still returns a parsed object when there is one', async () => {
    nock(ORIGIN)
      .post(feedPath('f1'))
      .reply(200, { items: [{ id: '1' }] });
    await expect(
      client().recommend({ userId: 'u1', feedId: 'f1', fields: ['id'] }),
    ).resolves.toEqual({ items: [{ id: '1' }] });
  });
});

describe('the circuit breaker opens after a precise number of attempts', () => {
  it('makes exactly five attempts, then stops', async () => {
    // Five, not four and not six. The suite previously only asserted that it
    // stopped eventually, so the threshold comparison was free to shift by one.
    let attempts = 0;
    nock(ORIGIN)
      .post(TRACK_PATH)
      .times(12)
      .reply(() => {
        attempts += 1;
        return [500, ''];
      });

    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(attempts).toBe(5);
    expect(
      logger.calls.error.some((a) =>
        /5 consecutive failures; stopping batching/.test(String(a[0])),
      ),
    ).toBe(true);
  }, 15_000);

  it('says how many events are still buffered when it gives up', async () => {
    nock(ORIGIN).post(TRACK_PATH).times(12).reply(500, '');
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await c.flush();

    const stop = logger.calls.error.find((a) => /stopping batching/.test(String(a[0])));
    expect(stop).toBeDefined();
    // The count is the whole point of the sentence: it tells an operator how much
    // data is sitting in memory unsent.
    expect(String(stop![0])).toMatch(/\d+ event\(s\) remain buffered\./);
    expect(String(stop![0])).not.toMatch(
      /^\[intempt\] 5 consecutive failures; stopping batching\. $/,
    );
  }, 15_000);

  it('drops a subsequent event and names it, once stopped', async () => {
    nock(ORIGIN).post(TRACK_PATH).times(12).reply(500, '');
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.flush();

    await c.track('after-stop', { userId: 'u1' });
    const dropped = logger.calls.error.find((a) =>
      /batching is stopped; event dropped/.test(String(a[0])),
    );
    expect(dropped).toBeDefined();
    // The metadata is what makes the log actionable; an empty object would say
    // an event was lost without saying which.
    expect(dropped![1]).toMatchObject({ name: 'after-stop' });
  }, 15_000);
});

describe('backoff grows with consecutive failures', () => {
  it('doubles rather than halves', async () => {
    // With multiplication the waits climb; with division they all collapse onto
    // the 100ms floor and look identical, which is how the operator was free to
    // flip. flushMs is 60 so the first interval clears the floor.
    nock(ORIGIN).post(TRACK_PATH).times(12).reply(500, '');
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 60, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.flush();

    const waits = backoffs(logger);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(waits[0]).toBe(120);
    expect(waits[1]).toBe(240);
    expect(waits[2]).toBe(480);
  }, 20_000);

  it('floors a Retry-After of zero instead of retrying instantly', async () => {
    // A zero or already-past Retry-After must not become a hot loop. Accepting
    // it as an instruction would spend every attempt in the same millisecond.
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '0' });
    nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.flush();

    const waits = backoffs(logger);
    expect(waits).not.toContain(0);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    await c.close();
  }, 10_000);
});

describe('the flush trigger fires at exactly batch.size', () => {
  it('sends on the size-th event without waiting for the timer', async () => {
    // flushMs is ten seconds, so anything that arrives has to have been triggered
    // by the width check. An off-by-one there would leave the events buffered
    // until the timer, which this test does not wait for.
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .reply(200, '');

    const { c } = batched({
      batch: { size: 3, flushMs: 10_000, maxQueue: 50, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    expect(c.buffered).toBe(2); // still under the threshold
    await c.track('c', { userId: 'u1' });

    await waitFor(() => c.buffered === 0);
    expect(widths).toEqual([3]);
    await c.close();
  });
});

describe('a reduced batch width recovers', () => {
  it('widens again after a run of successes, instead of staying halved forever', async () => {
    // `batch` is sliced to the current width, so a comparison against the full
    // width could never be true once a 413 halved it: the reduction was
    // permanent for the life of the client and one transient 413 halved
    // throughput for good.
    const widths: number[] = [];
    let rejectWide = true;
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(40)
      .reply(function () {
        const n = widths[widths.length - 1] ?? 0;
        return rejectWide && n > 2 ? [413, ''] : [200, ''];
      });

    const { c } = batched({
      batch: { size: 4, flushMs: 10_000, maxQueue: 200, flushOnExit: false },
    });

    // One 413 at width 4 halves the width to 2.
    for (let i = 0; i < 4; i += 1) await c.track(`a${i}`, { userId: 'u1' });
    await c.flush();
    expect(widths).toContain(4); // the attempt that was rejected
    expect(widths.filter((w) => w === 4)).toHaveLength(1);

    // The server is healthy now. Ten successful sends at the reduced width earn
    // a wider attempt.
    rejectWide = false;
    const before = widths.length;
    for (let i = 0; i < 44; i += 1) await c.track(`b${i}`, { userId: 'u1' });
    await c.flush();

    const after = widths.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.max(...after)).toBe(4);
    expect(c.buffered).toBe(0);
    await c.close();
  }, 20_000);

  it('never exceeds batch.size even when maxRequestEvents is larger', async () => {
    // The width is the smaller of the two. Taking the larger would send requests
    // wider than the caller configured.
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(20)
      .reply(200, '');

    const { c } = batched({
      maxRequestEvents: 50,
      batch: { size: 2, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });
    for (let i = 0; i < 12; i += 1) await c.track(`e${i}`, { userId: 'u1' });
    await c.flush();

    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(2);
    await c.close();
  }, 10_000);

  it('returns to full width immediately once the oversized event is dropped', async () => {
    // A 413 on a single event means the width was never the problem, so the
    // width should reset rather than crawl back up.
    const widths: number[] = [];
    let rejectAll = true;
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(30)
      .reply(function () {
        return rejectAll ? [413, ''] : [200, ''];
      });

    const { c, logger } = batched({
      batch: { size: 4, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });
    for (let i = 0; i < 4; i += 1) await c.track(`a${i}`, { userId: 'u1' });
    await c.flush();

    // Every event was dropped one at a time; the width is back to full.
    expect(
      logger.calls.error.some((a) => /single event too large/.test(String(a[0]))),
    ).toBe(true);
    expect(c.buffered).toBe(0);

    rejectAll = false;
    const before = widths.length;
    for (let i = 0; i < 4; i += 1) await c.track(`b${i}`, { userId: 'u1' });
    await c.flush();

    expect(Math.max(...widths.slice(before))).toBe(4);
    await c.close();
  }, 20_000);
});

describe('the queue-full drop is reported with enough detail to act on', () => {
  it('names the event and the limit it hit', async () => {
    // The send is held open, so the queue cannot drain and the third event has
    // nowhere to go.
    nock(ORIGIN).post(TRACK_PATH).delay(300).reply(200, '');
    const { c, logger } = batched({
      batch: { size: 2, flushMs: 10_000, maxQueue: 2, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' }); // triggers the held flush
    await c.track('overflow', { userId: 'u1' });

    const dropped = logger.calls.error.find((a) =>
      /batch queue full; event dropped/.test(String(a[0])),
    );
    expect(dropped).toBeDefined();
    expect(dropped![1]).toMatchObject({ name: 'overflow', maxQueue: 2 });
    await c.close();
  }, 10_000);
});

describe('a gateway that rejects every single event does not loop forever', () => {
  it('stops batching after a run of drops with nothing accepted in between', async () => {
    // None of the other paths can trip the breaker here: a 413 returns before
    // #consecutiveFailures is incremented, and the single-event drop resets it so
    // that one oversized event does not stop batching. Without a drop budget a
    // gateway whose body limit sits below one event discards the entire stream —
    // halve to 1, drop, reset to full, halve again — forever.
    let attempts = 0;
    nock(ORIGIN)
      .post(TRACK_PATH)
      .times(60)
      .reply(() => {
        attempts += 1;
        return [413, ''];
      });

    const { c, logger } = batched({
      batch: { size: 2, flushMs: 10_000, maxQueue: 50, flushOnExit: false },
    });
    for (let i = 0; i < 12; i += 1) await c.track(`e${i}`, { userId: 'u1' });
    await c.flush();

    const stop = logger.calls.error.find((a) =>
      /consecutive events rejected as too large/.test(String(a[0])),
    );
    expect(stop).toBeDefined();
    expect(String(stop![0])).toMatch(/stopping batching/);
    expect(String(stop![0])).toMatch(/gateway's request body limit/);

    // It gave up rather than draining all 12 by dropping them one at a time.
    expect(c.buffered).toBeGreaterThan(0);
    const before = attempts;
    await c.flush();
    expect(attempts).toBe(before);
  }, 20_000);

  it('forgives an occasional oversized event when others do get through', async () => {
    // A successful send clears the drop tally, so one bad event costs one event.
    const widths: number[] = [];
    let rejectNext = true;
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(40)
      .reply(function () {
        if (rejectNext) {
          rejectNext = false;
          return [413, ''];
        }
        return [200, ''];
      });

    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10_000, maxQueue: 50, flushOnExit: false },
    });
    for (let i = 0; i < 8; i += 1) {
      await c.track(`e${i}`, { userId: 'u1' });
      rejectNext = i % 3 === 0; // a bad one every third round
      await c.flush();
    }

    expect(
      logger.calls.error.some((a) => /consecutive events rejected/.test(String(a[0]))),
    ).toBe(false);
    expect(c.buffered).toBe(0);
    await c.close();
  }, 20_000);
});

describe('widening rests on evidence actually gathered', () => {
  it('does not widen from sends narrower than the current width', async () => {
    // A trickle producer flushing one event per tick would otherwise earn a
    // widening from ten width-1 requests, none of which tested the width that a
    // 413 had just taken away.
    const widths: number[] = [];
    let rejectWide = true;
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(60)
      .reply(function () {
        const n = widths[widths.length - 1] ?? 0;
        return rejectWide && n > 2 ? [413, ''] : [200, ''];
      });

    const { c } = batched({
      batch: { size: 4, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });

    // Drop to width 2.
    for (let i = 0; i < 4; i += 1) await c.track(`a${i}`, { userId: 'u1' });
    await c.flush();
    rejectWide = false;

    // Twenty single-event flushes. Each is width 1, below the width of 2, so none
    // of them should count toward widening.
    const before = widths.length;
    for (let i = 0; i < 20; i += 1) {
      await c.track(`b${i}`, { userId: 'u1' });
      await c.flush();
    }

    const singles = widths.slice(before);
    expect(singles.every((w) => w === 1)).toBe(true);
    expect(Math.max(...singles)).toBe(1);
    await c.close();
  }, 20_000);
});
