import { describe, expect, it } from 'vitest';
import { Batcher } from '../src/batcher';
import { IntemptApiError } from '../src/transport';
import type { WireEvent } from '../src/types';
import { testLogger } from './helpers';

/**
 * `close()` used to await a full drain with no bound. Backoff is
 * `flushMs * 2 ** failures`, so with `flushMs: 60000` a shutdown hook could block
 * for roughly 24 minutes against a failing endpoint.
 *
 * These drive `Batcher` directly rather than going through the client, so the
 * budget can be milliseconds instead of the real 30 seconds. `closeBudgetMs` is
 * internal and deliberately absent from `IntemptConfig`; this is the only thing
 * that sets it.
 */

const OPTIONS = { size: 10, flushMs: 60_000, maxQueue: 100, flushOnExit: false };
const event = (name: string): WireEvent => ({
  name,
  payload: [{ eventId: name, timestamp: 1, userId: 'u1' }],
});

function failing(status: number) {
  return () =>
    Promise.reject(
      new IntemptApiError(`Intempt API responded ${status}`, { status, body: '' }),
    );
}

describe('close() is bounded', () => {
  it('returns inside its budget instead of blocking on backoff', async () => {
    const logger = testLogger();
    const b = new Batcher({
      options: OPTIONS,
      maxRequestEvents: 50,
      logger,
      send: failing(500),
      closeBudgetMs: 120,
    });
    b.enqueue(event('a'));

    // flushMs is 60s, so the first backoff alone is 120s. Unbounded, this would
    // sit here for minutes.
    const started = Date.now();
    await b.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);

  it('says how many events it gave up on', async () => {
    const logger = testLogger();
    const b = new Batcher({
      options: OPTIONS,
      maxRequestEvents: 50,
      logger,
      send: failing(500),
      closeBudgetMs: 120,
    });
    for (let i = 0; i < 4; i += 1) b.enqueue(event(`e${i}`));

    await b.close();

    const gaveUp = logger.calls.error.find((a) => /close\(\) gave up/.test(String(a[0])));
    expect(gaveUp).toBeDefined();
    // The count is the point: silent loss at shutdown is what this replaces.
    expect(String(gaveUp![0])).toMatch(/4 event\(s\) unsent/);
    expect(String(gaveUp![0])).toMatch(/after 120ms/);
  }, 10_000);

  it('still drains everything when the server is healthy', async () => {
    // The bound must not cost events that would have sent. A short budget plus a
    // working endpoint has to still deliver all of them.
    const sent: string[] = [];
    const logger = testLogger();
    const b = new Batcher({
      options: OPTIONS,
      maxRequestEvents: 50,
      logger,
      send: async (events) => {
        sent.push(...events.map((e) => e.name));
      },
      closeBudgetMs: 120,
    });
    for (let i = 0; i < 25; i += 1) b.enqueue(event(`e${i}`));

    await b.close();

    expect(sent).toHaveLength(25);
    expect(b.size).toBe(0);
    expect(logger.calls.error.some((a) => /gave up/.test(String(a[0])))).toBe(false);
  }, 10_000);

  it('leaves a plain flush() unbounded', async () => {
    // Only close() gives up. A caller who is not shutting down has not asked to.
    let attempts = 0;
    const logger = testLogger();
    const b = new Batcher({
      options: { ...OPTIONS, flushMs: 1 },
      maxRequestEvents: 50,
      logger,
      send: async () => {
        attempts += 1;
        if (attempts < 3) throw new IntemptApiError('boom', { status: 500, body: '' });
      },
      closeBudgetMs: 1,
    });
    b.enqueue(event('a'));

    // A budget of 1ms would abandon this immediately if flush() were bounded.
    await b.flush();

    expect(attempts).toBe(3);
    expect(b.size).toBe(0);
    expect(logger.calls.error.some((a) => /gave up/.test(String(a[0])))).toBe(false);
  }, 10_000);
});
