import { describe, expect, it } from 'vitest';
import { Batcher } from '../src/batcher';
import type { DeliveryFailure, SendOutcome } from '../src/delivery';
import type { WireEvent } from '../src/types';
import { testLogger, waitFor } from './helpers';

/**
 * INT-7436 regression. With the circuit breaker gone, a `beforeExit` drain against an unreachable
 * host kept its batch, the loop emptied, `beforeExit` fired again, and the process never exited
 * (probe: `timeout 20 node` on a default-config client pointed at 127.0.0.1:1 exits 124).
 *
 * Own file on purpose: emitting `beforeExit` runs every registered hook in the process.
 */

const event = (name: string): WireEvent => ({
  name,
  payload: [{ eventId: name, timestamp: 1, userId: 'u1' }],
});

const unreachable = async (events: WireEvent[]): Promise<SendOutcome> => ({
  ok: false,
  kept: true,
  failure: {
    kind: 'transport',
    eventCount: events.length,
    eventIds: events.map((e) => e.name),
    terminal: false,
  },
});

function batcher(send: (events: WireEvent[]) => Promise<SendOutcome>) {
  const failures: DeliveryFailure[] = [];
  const b = new Batcher({
    options: { size: 10, flushMs: 60_000, maxQueue: 100, flushOnExit: true },
    maxRequestEvents: 50,
    logger: testLogger(),
    send,
    report: (f) => failures.push(f),
  });
  return { b, failures };
}

describe('the beforeExit drain is final', () => {
  it('drops and reports a batch that could not reach the server, leaving nothing to re-drain', async () => {
    let attempts = 0;
    const { b, failures } = batcher(async (events) => {
      attempts += 1;
      return unreachable(events);
    });
    b.enqueue(event('a'));

    process.emit('beforeExit', 0);
    await waitFor(() => failures.length > 0);

    expect(b.size).toBe(0);
    expect(attempts).toBe(1);
    expect(failures.map((f) => [f.kind, f.terminal, f.eventCount])).toEqual([
      ['dropped', true, 1],
    ]);
    await b.close();
  });

  it('still keeps an unreachable batch on an ordinary flush', async () => {
    const { b, failures } = batcher(unreachable);
    b.enqueue(event('a'));

    await expect(b.flush()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(b.size).toBe(1);
    expect(failures.map((f) => [f.kind, f.terminal])).toEqual([['transport', false]]);
    await b.close();
  });

  it('refuses and reports an event enqueued after close()', async () => {
    const { b, failures } = batcher(async () => ({ ok: true }));
    await b.close();

    expect(b.enqueue(event('late'))).toBe(false);
    expect(failures.map((f) => [f.kind, f.eventCount])).toEqual([['dropped', 1]]);
  });
});
