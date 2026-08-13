import { describe, expect, it } from 'vitest';
import { SDK } from '../src';
import {
  API_KEY,
  CONSENT_PATH,
  HOST,
  ORG,
  ORIGIN,
  PROJECT,
  SOURCE,
  TRACK_PATH,
  client,
  nock,
  setupNock,
  testLogger,
} from './helpers';

setupNock();

/**
 * Each test here closes an uncovered line that guards a real behaviour. Lines
 * that were uncovered because they were unreachable or dead were deleted or
 * simplified in the source instead, which is the honest fix for those.
 */

describe('consent: options themselves must be an object', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'userId'],
    ['a number', 7],
  ])('rejects %s rather than reading properties off it', async (_label, value) => {
    await expect(client().consent.grant(value as never)).rejects.toThrow(
      /options are required/,
    );
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('names the method that was called', async () => {
    await expect(client().consent.revoke(undefined as never)).rejects.toThrow(
      /consent\.revoke: options are required/,
    );
    await expect(client().consent.grant(undefined as never)).rejects.toThrow(
      /consent\.grant: options are required/,
    );
  });
});

describe('trackBatch: the argument must be an array', () => {
  it.each([
    ['an object', { event: 'a', userId: 'u' }],
    ['a string', 'a'],
    ['undefined', undefined],
  ])('rejects %s instead of iterating it', async (_label, value) => {
    await expect(client().trackBatch(value as never)).rejects.toThrow(
      /events must be an array/,
    );
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('reserved event names: an explicit blank override is rejected', () => {
  it.each([
    [
      'identify',
      (c: ReturnType<typeof client>) => c.identify({ userId: 'u', event: '  ' }),
    ],
    [
      'group',
      (c: ReturnType<typeof client>) =>
        c.group({ userId: 'u', accountId: 'a', event: '' }),
    ],
  ])('%s refuses a blank event rather than sending it', async (_label, call) => {
    // Passing `event` explicitly opts out of the reserved name, so a blank value
    // is a mistake rather than "use the default".
    await expect(call(client())).rejects.toThrow(
      /must be a non-empty string when provided/,
    );
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('setConfig: the accepted paths, not just the rejected ones', () => {
  it('adopts a port when the new host carries one', async () => {
    const c = client();
    expect(c.config.port).toBeUndefined();

    c.setConfig({ host: `${HOST}:8443` });
    expect(c.config.port).toBe(8443);

    const scope = nock(`https://${HOST}:8443`).post(TRACK_PATH).reply(200, '');
    await c.track('a', { userId: 'u1' });
    scope.done();
    await c.close();
  });

  it('switches protocol, and the next request uses it', async () => {
    const c = client();
    c.setConfig({ protocol: 'http' });
    expect(c.config.protocol).toBe('http');

    const scope = nock(`http://${HOST}`).post(TRACK_PATH).reply(200, '');
    await c.track('a', { userId: 'u1' });
    scope.done();
    await c.close();
  });
});

describe('batcher: the idle timer flushes without an explicit flush()', () => {
  it('sends a partial batch once flushMs elapses', async () => {
    // Below batch.size, so only the scheduled timer can send it. This is the
    // path a long-lived process actually relies on.
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .reply(200, '');

    const c = client({
      logger: testLogger(),
      batch: { size: 50, flushMs: 30, maxQueue: 100, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    expect(c.buffered).toBe(2);

    await new Promise((r) => setTimeout(r, 200));

    expect(widths).toEqual([2]);
    expect(c.buffered).toBe(0);
    await c.close();
  });
});

describe('batcher: the beforeExit hook actually drains', () => {
  it('flushes when the process signals it is about to exit', async () => {
    // flushOnExit is the default, and it is the only thing standing between a
    // buffered event and a process that ends normally.
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .reply(200, '');

    const c = client({
      logger: testLogger(),
      batch: { size: 50, flushMs: 10_000, maxQueue: 100, flushOnExit: true },
    });
    await c.track('a', { userId: 'u1' });
    expect(c.buffered).toBe(1);

    process.emit('beforeExit', 0);
    await new Promise((r) => setTimeout(r, 100));

    expect(widths).toEqual([1]);
    expect(c.buffered).toBe(0);
    await c.close();
  });
});

describe('ecommerce: an explicit timestamp reaches every product line', () => {
  it('uses the supplied time rather than now', async () => {
    // trackLines has its own timestamp branch, separate from track().
    const bodies: Array<{ track: Array<{ payload: Array<Record<string, unknown>> }> }> =
      [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: (typeof bodies)[number]) => {
        bodies.push(b);
        return true;
      })
      .reply(200, '');

    const when = new Date('2026-03-04T05:06:07.000Z');
    await client().ecommerce.ordered({
      userId: 'u1',
      products: [{ productId: 'p1' }, { productId: 'p2' }],
      timestamp: when,
    } as never);

    const stamps = bodies[0]!.track[0]!.payload.map((i) => i.timestamp);
    expect(stamps).toEqual([when.getTime(), when.getTime()]);
  });
});

describe('batcher: an error that is not an IntemptApiError', () => {
  it('treats it as retryable and eventually stops, rather than crashing the drain', async () => {
    // A circular payload makes JSON.stringify throw a raw TypeError inside post(),
    // so #handleFailure receives something that is not an IntemptApiError. Its
    // status is unknown, so it must be treated as transient and hit the breaker.
    const logger = testLogger();
    const c = client({
      logger,
      batch: { size: 1, flushMs: 1, maxQueue: 10, flushOnExit: false },
    });

    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    await c.track('circular', { userId: 'u1', properties: circular });
    await c.flush();

    expect(
      logger.calls.error.some((a) => String(a[0]).includes('stopping batching')),
    ).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('legacy shim: the optional arguments really are optional', () => {
  function legacy(): SDK {
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ host: HOST });
    return sdk;
  }

  interface WireBody {
    track: Array<{ name: string; payload: Array<Record<string, unknown>> }>;
  }

  function capture(times = 1): WireBody[] {
    const bodies: WireBody[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: WireBody) => {
        bodies.push(b);
        return true;
      })
      .times(times)
      .reply(200, '');
    return bodies;
  }

  it('group() without attributes sends no accountAttributes key', async () => {
    const bodies = capture();
    await legacy().group('p1', 'acct-1');
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.accountId).toBe('acct-1');
    expect(item).not.toHaveProperty('accountAttributes');
  });

  it('record() with only the required arguments omits every optional key', async () => {
    const bodies = capture();
    await legacy().record('p1', 'battle');
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(bodies[0]!.track[0]!.name).toBe('battle');
    for (const absent of [
      'data',
      'userAttributes',
      'accountAttributes',
      'userId',
      'accountId',
    ]) {
      expect(item, absent).not.toHaveProperty(absent);
    }
  });

  it('record() with data but no attributes keeps data and drops the rest', async () => {
    const bodies = capture();
    await legacy().record('p1', 'battle', 'john', 'Stark', { winner: 'Stark' });
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.data).toEqual({ winner: 'Stark' });
    expect(item).not.toHaveProperty('userAttributes');
    expect(item).not.toHaveProperty('accountAttributes');
  });

  it('record() with userAttributes but no accountAttributes keeps only the first', async () => {
    const bodies = capture();
    await legacy().record('p1', 'battle', 'john', 'Stark', undefined, { kills: 74 });
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.userAttributes).toEqual({ kills: 74 });
    expect(item).not.toHaveProperty('accountAttributes');
    expect(item).not.toHaveProperty('data');
  });

  it('identify() without eventTitle or traits uses the reserved name only', async () => {
    const bodies = capture();
    await legacy().identify('p1', 'john');
    expect(bodies[0]!.track[0]!.name).toBe('Identify');
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.userId).toBe('john');
    expect(item).not.toHaveProperty('userAttributes');
  });

  it('consent() with a category but no expiry, email or message', async () => {
    const bodies: Record<string, unknown>[] = [];
    nock(ORIGIN)
      .post(CONSENT_PATH, (b: Record<string, unknown>) => {
        bodies.push(b);
        return true;
      })
      .reply(200, '');

    await legacy().consent('p1', 'reject', 'marketing');

    expect(bodies[0]!.category).toBe('marketing');
    expect(bodies[0]!.validUntil).toBe('unlimited');
    for (const absent of ['email', 'message']) {
      expect(bodies[0], absent).not.toHaveProperty(absent);
    }
  });

  it('record() with accountAttributes forwards them', async () => {
    // No existing test passed the seventh argument, so the branch that keeps it
    // had never run.
    const bodies = capture();
    await legacy().record('p1', 'battle', 'john', 'Stark', undefined, undefined, {
      battle_status: 'victory',
    });
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.accountAttributes).toEqual({ battle_status: 'victory' });
    expect(item).not.toHaveProperty('userAttributes');
  });

  it('flush() forwards to the client', async () => {
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE, 10_000, 50);
    sdk.v2.setConfig({ host: HOST });
    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    await sdk.track('p1', 'purchase', { total: 1 });
    expect(sdk.v2.buffered).toBe(1);
    await sdk.flush();

    expect(scope.isDone()).toBe(true);
    expect(sdk.v2.buffered).toBe(0);
    await sdk.close();
  });

  it('consents() without the optional fields still posts a valid record', async () => {
    const bodies: Record<string, unknown>[] = [];
    nock(ORIGIN)
      .post(CONSENT_PATH, (b: Record<string, unknown>) => {
        bodies.push(b);
        return true;
      })
      .reply(200, '');

    await legacy().consents('p1', 'accept');

    expect(bodies[0]!.action).toBe('accept');
    expect(bodies[0]!.validUntil).toBe('unlimited');
    for (const absent of ['category', 'email', 'message']) {
      expect(bodies[0], absent).not.toHaveProperty(absent);
    }
  });
});
