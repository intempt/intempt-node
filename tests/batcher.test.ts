import { describe, expect, it, vi } from 'vitest';
import { ORIGIN, TRACK_PATH, client, nock, setupNock, testLogger } from './helpers';

setupNock();

interface WireBody {
  track: Array<{ name: string; payload: unknown[] }>;
}

/** Records the event-count of every request that reaches the interceptor. */
function counter(
  times: number,
  status: number | number[] = 200,
  headers?: Record<string, string>,
) {
  const widths: number[] = [];
  const statuses = Array.isArray(status) ? [...status] : Array(times).fill(status);
  const scope = nock(ORIGIN)
    .post(TRACK_PATH, (body: WireBody) => {
      widths.push(body.track.length);
      return true;
    })
    .times(times);

  // nock replies in registration order; build one interceptor per status.
  scope.reply(function () {
    const next = statuses.shift() ?? 200;
    return [next, '', headers ?? {}];
  });

  return widths;
}

/** flushMs of 1 keeps real backoff in the low milliseconds; no fake timers. */
function batched(overrides: Record<string, unknown> = {}) {
  const logger = testLogger();
  const c = client({
    logger,
    batch: { size: 4, flushMs: 1, maxQueue: 100, flushOnExit: false },
    ...overrides,
  });
  return { c, logger };
}

describe('batcher: buffering', () => {
  it('does not send until the buffer reaches batch.size', async () => {
    const widths = counter(1);
    const { c } = batched();

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    expect(widths).toEqual([]);
    expect(c.buffered).toBe(2);

    await c.track('c', { userId: 'u1' });
    await c.track('d', { userId: 'u1' });
    await c.flush();

    expect(widths).toEqual([4]);
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('flush() drains everything, in chunks capped by maxRequestEvents', async () => {
    const widths = counter(3);
    const { c } = batched({
      batch: { size: 100, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
      maxRequestEvents: 4,
    });

    for (let i = 0; i < 10; i += 1) {
      await c.track(`e${i}`, { userId: 'u1' });
    }
    await c.flush();

    expect(widths).toEqual([4, 4, 2]);
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('close() returns only once the buffer is empty', async () => {
    const widths = counter(1);
    const { c } = batched({
      batch: { size: 100, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    expect(c.buffered).toBe(1);

    await c.close();

    expect(widths).toEqual([1]);
    expect(c.buffered).toBe(0);
  });

  it('does not lose events appended during an in-flight flush', async () => {
    // The 1.x bug: `await recordTracks()` then `tearDown()` wiped anything
    // pushed during the await.
    const widths = counter(2);
    const { c } = batched({
      batch: { size: 100, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
    });

    await c.track('first', { userId: 'u1' });
    const flushing = c.flush();
    await c.track('during', { userId: 'u1' });
    await flushing;
    await c.flush();

    expect(widths.reduce((a, b) => a + b, 0)).toBe(2);
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('drops and logs past maxQueue instead of growing without bound', async () => {
    // Reachable when sends are slower than arrivals: the in-flight slice stays
    // queued until the server confirms, so new events hit the ceiling.
    nock(ORIGIN).post(TRACK_PATH).delayConnection(120).reply(200, '');

    const { c, logger } = batched({
      batch: { size: 2, flushMs: 10_000, maxQueue: 2, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' }); // reaches size, starts a flush
    await c.track('c', { userId: 'u1' }); // queue still holds a+b in flight

    expect(c.buffered).toBe(2);
    expect(
      logger.calls.error.some((args) => String(args[0]).includes('queue full')),
    ).toBe(true);

    await c.close();
  });
});

describe('batcher: retry table', () => {
  it('halves the batch on 413 and retries', async () => {
    const widths = counter(3, [413, 200, 200]);
    const { c, logger } = batched();

    for (const name of ['a', 'b', 'c', 'd']) {
      await c.track(name, { userId: 'u1' });
    }
    await c.flush();

    expect(widths).toEqual([4, 2, 2]);
    expect(
      logger.calls.warn.some((args) => String(args[0]).includes('reducing batch size')),
    ).toBe(true);
    await c.close();
  });

  it('drops a single event that is still too large at 413', async () => {
    const widths = counter(1, [413]);
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });

    await c.track('huge', { userId: 'u1' });
    await c.flush();

    expect(widths).toEqual([1]);
    expect(c.buffered).toBe(0);
    expect(
      logger.calls.error.some((args) =>
        String(args[0]).includes('single event too large'),
      ),
    ).toBe(true);
    await c.close();
  });

  it('retries a 429 and honours Retry-After', async () => {
    const widths = counter(2, [429, 200], { 'Retry-After': '0' });
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(widths).toEqual([1, 1]);
    expect(c.buffered).toBe(0);
    expect(
      logger.calls.warn.some((args) => String(args[0]).includes('retrying in 0ms')),
    ).toBe(true);
    await c.close();
  });

  it('retries 5xx with growing backoff', async () => {
    const widths = counter(3, [500, 503, 200]);
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 1, maxQueue: 10, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(widths).toEqual([1, 1, 1]);
    const delays = logger.calls.warn
      .map((args) => /retrying in (\d+)ms/.exec(String(args[0]))?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(delays).toEqual([2, 4]);
    await c.close();
  });

  it('drops the batch on a non-retryable 4xx without looping', async () => {
    const widths = counter(1, [400]);
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(widths).toEqual([1]);
    expect(c.buffered).toBe(0);
    expect(
      logger.calls.error.some((args) => String(args[0]).includes('non-retryable')),
    ).toBe(true);
    await c.close();
  });

  it('stops after five consecutive failures and says how many are stranded', async () => {
    const widths = counter(5, [500, 500, 500, 500, 500]);
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 1, maxQueue: 10, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(widths).toHaveLength(5);
    expect(c.buffered).toBe(1);
    expect(
      logger.calls.error.some((args) => String(args[0]).includes('stopping batching')),
    ).toBe(true);

    // Further events are refused loudly rather than buffered forever.
    await c.track('b', { userId: 'u1' });
    expect(
      logger.calls.error.some((args) => String(args[0]).includes('batching is stopped')),
    ).toBe(true);
  });
});

describe('batcher: exit hook', () => {
  it('registers a beforeExit listener when flushOnExit is on', () => {
    const spy = vi.spyOn(process, 'on');
    const c = client({
      batch: { size: 10, flushMs: 1000, flushOnExit: true },
    });

    expect(spy.mock.calls.some(([event]) => event === 'beforeExit')).toBe(true);
    void c.close();
  });

  it('removes the listener on close', async () => {
    const before = process.listenerCount('beforeExit');
    const c = client({ batch: { size: 10, flushMs: 1000, flushOnExit: true } });
    expect(process.listenerCount('beforeExit')).toBe(before + 1);

    await c.close();
    expect(process.listenerCount('beforeExit')).toBe(before);
  });

  it('registers nothing when batching is off', () => {
    const before = process.listenerCount('beforeExit');
    client();
    expect(process.listenerCount('beforeExit')).toBe(before);
  });
});
