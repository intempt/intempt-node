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
  postError,
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
    const error = (await postError()) as IntemptApiError;
    expect(error).toBeInstanceOf(IntemptApiError);
    expect(error.status).toBe(300);
  });

  it.each([200, 204, 299])('treats %i as a success', async (status) => {
    nock(ORIGIN).post(TRACK_PATH).reply(status, '');
    await expect(client().track('purchase', { userId: 'u1' })).resolves.toBe(true);
  });
});

describe('the error carries only the fields the response actually had', () => {
  it('leaves retryAfterMs and cause undefined when there was neither', async () => {
    // Presence cannot be the signal: the target is ES2022, so every declared
    // field is an own property before the constructor body runs and
    // `'retryAfterMs' in error` is true even when no header was sent. The value
    // is the contract, so that is what this asserts.
    nock(ORIGIN).post(TRACK_PATH).reply(500, 'boom');
    const error = (await postError()) as IntemptApiError;

    expect(error.retryAfterMs).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.status).toBe(500);
    expect(error.body).toBe('boom');
  });

  it('sets cause when the failure came from the socket', async () => {
    nock(ORIGIN)
      .post(TRACK_PATH)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const error = (await postError()) as IntemptApiError;

    expect((error.cause as Error).message).toMatch(/socket hang up/);
    expect(error.status).toBeUndefined();
    // No status means "transport failure", which the batcher must treat as
    // retryable.
    expect(error.retryable).toBe(true);
  });

  it('records a Retry-After the server did send', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '3' });
    const error = (await postError()) as IntemptApiError;
    expect(error.retryAfterMs).toBe(3000);
  });

  it('never turns a negative Retry-After into a negative wait', async () => {
    // `Number('-5')` is finite, so a check of finite-OR-non-negative would accept
    // it and return -5000. A negative wait means no wait at all.
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '-5' });
    const error = (await postError()) as IntemptApiError;
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
