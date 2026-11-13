import { describe, expect, it } from 'vitest';
import { Batcher } from '../src/batcher';
import { deliver } from '../src/delivery';
import type { DeliveryFailure, SendOutcome } from '../src/delivery';
import { IntemptApiError } from '../src/transport';
import type { WireEvent } from '../src/types';
import { testLogger } from './helpers';

/**
 * `close()` must return inside its budget. Before INT-7436 the risk was exponential backoff
 * (`flushMs * 2 ** failures`); now it is the one 429/503 resend wait and a slow backlog.
 *
 * These drive `Batcher` directly rather than going through the client, so the budget can be
 * milliseconds instead of the real 30 seconds. `closeBudgetMs` is internal and deliberately absent
 * from `IntemptConfig`; this is the only thing that sets it. Sends go through the real `deliver`
 * policy so the deadline is exercised where it is enforced.
 */

const OPTIONS = { size: 10, flushMs: 60_000, maxQueue: 100, flushOnExit: false };
const event = (name: string): WireEvent => ({
  name,
  payload: [{ eventId: name, timestamp: 1, userId: 'u1' }],
});

function policy(post: () => Promise<unknown>) {
  return (events: WireEvent[], deadline: number | undefined): Promise<SendOutcome> =>
    deliver(events, post, deadline !== undefined ? { deadline } : {});
}

function batcher(
  send: (events: WireEvent[], deadline: number | undefined) => Promise<SendOutcome>,
  closeBudgetMs: number,
  options = OPTIONS,
) {
  const logger = testLogger();
  const failures: DeliveryFailure[] = [];
  const b = new Batcher({
    options,
    maxRequestEvents: 50,
    logger,
    send,
    report: (f) => failures.push(f),
    closeBudgetMs,
  });
  return { b, logger, failures };
}

describe('close() is bounded', () => {
  it('drops instead of starting a resend wait that outlives the budget', async () => {
    const { b, failures } = batcher(
      policy(() =>
        Promise.reject(
          new IntemptApiError('Intempt API responded 503', {
            status: 503,
            retryAfterMs: 3_000,
          }),
        ),
      ),
      120,
    );
    b.enqueue(event('a'));

    const started = Date.now();
    await expect(b.close()).resolves.toEqual({ sent: 0, failed: 1 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(failures.map((f) => [f.kind, f.status])).toEqual([['dropped', 503]]);
  }, 10_000);

  it('drops and counts a batch kept because the server was unreachable', async () => {
    const refused = new IntemptApiError('connect ECONNREFUSED', {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    });
    const { b, logger, failures } = batcher(
      policy(() => Promise.reject(refused)),
      120,
    );
    for (let i = 0; i < 4; i += 1) b.enqueue(event(`e${i}`));

    await expect(b.close()).resolves.toEqual({ sent: 0, failed: 4 });

    const gaveUp = logger.calls.error.find((a) => /close\(\) dropped/.test(String(a[0])));
    expect(String(gaveUp?.[0])).toMatch(/dropped 4 unsent event\(s\)/);
    expect(failures.map((f) => [f.kind, f.eventCount])).toEqual([
      ['transport', 4],
      ['dropped', 4],
    ]);
  }, 10_000);

  it('still drains everything when the server is healthy', async () => {
    const sent: string[] = [];
    const { b, logger } = batcher(async (events) => {
      sent.push(...events.map((e) => e.name));
      return { ok: true };
    }, 120);
    for (let i = 0; i < 25; i += 1) b.enqueue(event(`e${i}`));

    await expect(b.close()).resolves.toEqual({ sent: 25, failed: 0 });

    expect(sent).toHaveLength(25);
    expect(b.size).toBe(0);
    expect(logger.calls.error.some((a) => /close\(\) dropped/.test(String(a[0])))).toBe(
      false,
    );
  }, 10_000);

  it('stops on the deadline even when every send succeeds, just slowly', async () => {
    // Found by mutation testing: making #outOfCloseBudget() always return false
    // left every other test green. 20 sends at 60ms is 1.2s against 150ms.
    const sent: string[] = [];
    const { b, logger } = batcher(
      async (events) => {
        await new Promise((r) => setTimeout(r, 60));
        sent.push(...events.map((e) => e.name));
        return { ok: true };
      },
      150,
      { ...OPTIONS, size: 1 },
    );
    for (let i = 0; i < 20; i += 1) b.enqueue(event(`e${i}`));

    const result = await b.close();

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(20);
    expect(result).toEqual({ sent: sent.length, failed: 20 - sent.length });
    expect(b.size).toBe(0);
    expect(logger.calls.error.some((a) => /close\(\) dropped/.test(String(a[0])))).toBe(
      true,
    );
  }, 15_000);

  it('applies no deadline to a plain flush(): the one resend still happens', async () => {
    let attempts = 0;
    const { b } = batcher(
      policy(async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new IntemptApiError('busy', { status: 503, retryAfterMs: 0 });
        }
      }),
      1,
      { ...OPTIONS, flushMs: 1 },
    );
    b.enqueue(event('a'));

    await expect(b.flush()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(attempts).toBe(2);
  }, 10_000);
});
