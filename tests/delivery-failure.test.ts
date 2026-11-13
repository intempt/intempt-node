import { describe, expect, it } from 'vitest';
import { ORIGIN, TRACK_PATH, client, nock, setupNock, testLogger } from './helpers';

setupNock();

/**
 * INT-7444, CONTRACT-R2 §S2: one `onDeliveryFailure` listener, fired ONCE per batch on its final
 * outcome; `track` resolves whether the event was accepted and never rejects for delivery;
 * `flush()` and `close()` resolve `{ sent, failed }`.
 */

type Failure = {
  kind: string;
  status?: number;
  eventCount: number;
  eventIds: string[];
  retryAfter?: number;
  terminal: boolean;
};

function batched(
  extra: Record<string, unknown> = {},
  batch: Record<string, unknown> = {},
) {
  const failures: Failure[] = [];
  const logger = testLogger();
  const c = client({
    logger,
    batch: { size: 4, flushMs: 1, maxQueue: 100, flushOnExit: false, ...batch },
    onDeliveryFailure: (f: Failure) => failures.push(f),
    ...extra,
  } as never);
  return { c, failures, logger };
}

function idsSent(): string[] {
  const ids: string[] = [];
  nock(ORIGIN)
    .post(TRACK_PATH, (body: { track: { payload: { eventId: string }[] }[] }) => {
      for (const e of body.track) ids.push(e.payload[0]!.eventId);
      return true;
    })
    .times(2)
    .reply(503, '');
  return ids;
}

describe('onDeliveryFailure (INT-7444)', () => {
  it('fires once with the terminal outcome after the one 503 resend fails', async () => {
    const ids = idsSent();
    const { c, failures } = batched();

    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(failures).toEqual([
      {
        kind: 'terminal',
        status: 503,
        eventCount: 1,
        eventIds: [ids[0]],
        terminal: true,
      },
    ]);
  });

  it('fires transport once for a batch that stays unreachable, then dropped at close', async () => {
    nock(ORIGIN)
      .post(TRACK_PATH)
      .times(3)
      .replyWithError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    const { c, failures } = batched();

    await c.track('a', { userId: 'u1' });
    await c.flush();
    await c.flush();
    expect(failures.map((f) => [f.kind, f.terminal])).toEqual([['transport', false]]);

    await c.close();
    expect(failures.map((f) => [f.kind, f.terminal])).toEqual([
      ['transport', false],
      ['dropped', true],
    ]);
  });

  it('a listener that throws is caught and logged, and flush still resolves', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(400, '');
    const logger = testLogger();
    const c = client({
      logger,
      batch: { size: 4, flushMs: 1, maxQueue: 100, flushOnExit: false },
      onDeliveryFailure: () => {
        throw new Error('listener boom');
      },
    } as never);

    await c.track('a', { userId: 'u1' });
    await expect(c.flush()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(logger.calls.error.flat().map(String).join(' ')).toContain('listener boom');
  });

  it('direct mode: fires once and track resolves false; a delivered track resolves true', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(500, '');
    nock(ORIGIN).post(TRACK_PATH).reply(200, {});
    const failures: Failure[] = [];
    const c = client({ onDeliveryFailure: (f: Failure) => failures.push(f) } as never);

    await expect(c.track('a', { userId: 'u1' })).resolves.toBe(false);
    await expect(c.track('b', { userId: 'u1' })).resolves.toBe(true);
    expect(failures.map((f) => [f.kind, f.status, f.eventCount])).toEqual([
      ['terminal', 500, 1],
    ]);
  });
});

describe('flush() and close() resolve { sent, failed } (INT-7444)', () => {
  it('counts the events each outcome covered', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(200, {});
    nock(ORIGIN).post(TRACK_PATH).reply(400, '');
    const { c } = batched({}, { flushMs: 60_000 });

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await expect(c.flush()).resolves.toEqual({ sent: 2, failed: 0 });

    await c.track('c', { userId: 'u1' });
    await expect(c.flush()).resolves.toEqual({ sent: 0, failed: 1 });
  });

  it('close() reports what it sent', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(200, {});
    const { c } = batched();

    await c.track('a', { userId: 'u1' });
    await expect(c.close()).resolves.toEqual({ sent: 1, failed: 0 });
  });

  it('flush() without batching resolves zeros', async () => {
    const c = client();
    await expect(c.flush()).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('track in batch mode resolves true when queued and false when the queue is full', async () => {
    const { c, failures } = batched({}, { size: 2, maxQueue: 2, flushMs: 60_000 });
    nock(ORIGIN).post(TRACK_PATH).delay(50).reply(200, {});

    await expect(c.track('a', { userId: 'u1' })).resolves.toBe(true);
    // The second fills the batch and starts a flush that is still in flight for the third.
    await expect(c.track('b', { userId: 'u1' })).resolves.toBe(true);
    await expect(c.track('c', { userId: 'u1' })).resolves.toBe(false);
    expect(failures.map((f) => [f.kind, f.eventCount, f.terminal])).toEqual([
      ['dropped', 1, true],
    ]);
    await c.close();
  });
});

describe('onDeliveryFailure is fixed at construction (INT-7444)', () => {
  it('setConfig refuses it rather than silently ignoring it', () => {
    const patch = { onDeliveryFailure: () => undefined } as never;
    expect(() => client().setConfig(patch)).toThrow(
      /onDeliveryFailure.*fixed at construction/,
    );
  });

  it('init refuses a listener that is not a function', () => {
    expect(() => client({ onDeliveryFailure: 'nope' } as never)).toThrow(
      /onDeliveryFailure must be a function/,
    );
  });
});

/**
 * Ruling R4 queue cap (parity with intempt-php 2915a01): at maxQueue the oldest event that no send
 * is carrying is evicted and reported `dropped`, the new event is queued and `track` resolves
 * true. Events in flight are never evicted: `#settle` removes them by position after the send.
 */
describe('queue cap evicts the oldest waiting event (R4)', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function names(): string[][] {
    const seen: string[][] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (body: { track: { name: string }[] }) => {
        seen.push(body.track.map((e) => e.name));
        return true;
      })
      .times(5)
      .reply(200, {});
    return seen;
  }

  it('evicts the held head of a kept batch, queues the new event and resolves true', async () => {
    nock(ORIGIN)
      .post(TRACK_PATH)
      .replyWithError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    const { c, failures, logger } = batched(
      {},
      { size: 2, maxQueue: 3, flushMs: 60_000 },
    );

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await settle(20);
    await c.track('c', { userId: 'u1' });
    const keptIds = failures[0]!.eventIds;

    await expect(c.track('d', { userId: 'u1' })).resolves.toBe(true);
    expect(c.buffered).toBe(3);
    expect(failures.map((f) => [f.kind, f.eventCount, f.terminal])).toEqual([
      ['transport', 2, false],
      ['dropped', 1, true],
    ]);
    expect(failures[1]!.eventIds).toEqual([keptIds[0]]);
    expect(
      logger.calls.error.some((args) => String(args[0]).includes('oldest event dropped')),
    ).toBe(true);

    const seen = names();
    await expect(c.flush()).resolves.toEqual({ sent: 3, failed: 0 });
    expect(seen).toEqual([['b', 'c'], ['d']]);
    await c.close();
  });

  it('never evicts an event a send is carrying', async () => {
    const seen: string[][] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (body: { track: { name: string }[] }) => {
        seen.push(body.track.map((e) => e.name));
        return true;
      })
      .times(3)
      .delay(80)
      .reply(200, {});
    const { c, failures } = batched({}, { size: 2, maxQueue: 3, flushMs: 60_000 });

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' }); // starts a send carrying a+b
    await c.track('c', { userId: 'u1' });
    await expect(c.track('d', { userId: 'u1' })).resolves.toBe(true);

    expect(failures.map((f) => [f.kind, f.eventCount])).toEqual([['dropped', 1]]);
    await c.flush();
    expect(seen).toEqual([['a', 'b'], ['d']]);
    await c.close();
  });
});
