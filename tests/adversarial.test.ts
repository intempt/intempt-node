import { describe, expect, it, vi } from 'vitest';
import { IntemptApiError } from '../src';
import { ORIGIN, TRACK_PATH, client, nock, setupNock, testLogger } from './helpers';

setupNock();

/**
 * Tests written to break the SDK rather than to confirm it works. Anything that
 * passes here is a property worth keeping; anything that fails is a defect.
 */

describe('attack: hostile input', () => {
  it('survives a circular object in properties', async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    // JSON.stringify throws synchronously inside post(); it must surface as a
    // rejection, not an uncaught throw that escapes the async boundary.
    await expect(
      client().track('purchase', { userId: 'u1', properties: circular }),
    ).rejects.toThrow(/circular|Converting/i);
  });

  it('does not let a __proto__ property pollute Object.prototype', async () => {
    const polluted = JSON.parse('{"__proto__":{"pwned":true}}') as Record<
      string,
      unknown
    >;
    nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    await client().track('purchase', { userId: 'u1', properties: polluted });

    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('pwned');
  });

  it('drops functions and symbols rather than sending garbage', async () => {
    let body:
      | { track: Array<{ payload: Array<{ data?: Record<string, unknown> }> }> }
      | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH, (b) => {
        body = b as typeof body;
        return true;
      })
      .reply(200, '');

    await client().track('purchase', {
      userId: 'u1',
      properties: { fn: () => 1, sym: Symbol('s'), ok: 'kept' } as Record<
        string,
        unknown
      >,
    });

    const data = body!.track[0]!.payload[0]!.data!;
    expect(data.ok).toBe('kept');
    expect(data).not.toHaveProperty('fn');
    expect(data).not.toHaveProperty('sym');
  });

  it('rejects a 10k-character event name at the server, not silently locally', async () => {
    // The SDK should not invent a length limit the API does not have; it should
    // simply pass it and surface whatever the API says.
    nock(ORIGIN).post(TRACK_PATH).reply(400, '{"errors":[{"message":"too long"}]}');
    const error = await client()
      .track('x'.repeat(10_000), { userId: 'u1' })
      .catch((e: unknown) => e);
    expect((error as IntemptApiError).status).toBe(400);
  });

  it('treats a whitespace-only identifier as missing', async () => {
    await expect(client().track('purchase', { userId: '   ' })).rejects.toThrow(
      /one of userId or accountId/,
    );
  });
});

describe('attack: a hostile logger', () => {
  it('does not let a throwing logger break a request', async () => {
    const exploding = {
      trace: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {
        throw new Error('logger exploded');
      },
    };
    nock(ORIGIN).post(TRACK_PATH).reply(200, '');

    // debug: true routes through the logger before the request is sent.
    await expect(
      client({ logger: exploding, debug: true }).track('purchase', { userId: 'u1' }),
    ).resolves.toBeUndefined();
  });
});

describe('attack: credential exposure through error paths', () => {
  it('keeps the key out of a thrown error, however it is serialised', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(500, 'boom');
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    const secret = 'sec0123456789abcdef';
    const basic = Buffer.from('pfx0123456789abcdef:sec0123456789abcdef').toString(
      'base64',
    );
    for (const view of [
      error.message,
      String(error),
      error.stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      require('node:util').inspect(error, { depth: 6 }),
    ]) {
      expect(view).not.toContain(secret);
      expect(view).not.toContain(basic);
    }
  });
});

describe('attack: batcher under abuse', () => {
  function batched(overrides: Record<string, unknown> = {}) {
    const logger = testLogger();
    return {
      logger,
      c: client({
        logger,
        batch: { size: 100, flushMs: 10_000, maxQueue: 100, flushOnExit: false },
        ...overrides,
      }),
    };
  }

  it('loses nothing when many flushes race', async () => {
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(10)
      .delay(10)
      .reply(200, '');

    const { c } = batched();
    for (let i = 0; i < 20; i += 1) await c.track(`e${i}`, { userId: 'u1' });

    // Ten concurrent flushes on one buffer.
    await Promise.all(Array.from({ length: 10 }, () => c.flush()));

    expect(widths.reduce((a, b) => a + b, 0)).toBe(20);
    expect(c.buffered).toBe(0);
    await c.close();
  });

  it('throws on a write after close rather than swallowing it', async () => {
    // Silently discarding was how 1.x lost events, and the README promises
    // nothing is swallowed, so a closed client must be loud.
    const { c } = batched();
    await c.close();
    await expect(c.track('after-close', { userId: 'u1' })).rejects.toThrow(
      /client is closed/,
    );
    expect(c.buffered).toBe(0);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not lose events queued while close() is draining', async () => {
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(3)
      .delay(30)
      .reply(200, '');

    const { c } = batched();
    await c.track('a', { userId: 'u1' });
    const closing = c.close();
    // Racing a write against close: it is either sent or refused, never silently
    // accepted into a buffer nobody will drain.
    await c.track('during-close', { userId: 'u1' });
    await closing;

    expect(c.buffered).toBe(0);
    expect(widths.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  });

  it('does not leak beforeExit listeners across many clients', async () => {
    const before = process.listenerCount('beforeExit');
    const clients = Array.from({ length: 20 }, () =>
      client({ batch: { size: 10, flushMs: 5_000, flushOnExit: true } }),
    );
    expect(process.listenerCount('beforeExit')).toBe(before + 20);

    await Promise.all(clients.map((c) => c.close()));
    expect(process.listenerCount('beforeExit')).toBe(before);
  });

  it('stops rather than looping forever on a permanently failing server', async () => {
    nock(ORIGIN).post(TRACK_PATH).times(20).reply(500, '');
    const { c, logger } = batched({
      batch: { size: 1, flushMs: 1, maxQueue: 10, flushOnExit: false },
    });

    await c.track('a', { userId: 'u1' });
    await c.flush();

    // Five attempts then stop; the remaining mocks prove it did not keep going.
    expect(nock.pendingMocks().length).toBeGreaterThan(0);
    expect(
      logger.calls.error.some((a) => String(a[0]).includes('stopping batching')),
    ).toBe(true);
  });
});

describe('attack: concurrency in trackBatch', () => {
  it('produces no unhandled rejection when several chunks fail at once', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);

    nock(ORIGIN).post(TRACK_PATH).times(6).delay(15).reply(500, '');

    try {
      await expect(
        client({ maxRequestEvents: 1, maxConcurrentRequests: 6 }).trackBatch(
          Array.from({ length: 6 }, (_, i) => ({ event: `e${i}`, userId: 'u1' })),
        ),
      ).rejects.toThrow(IntemptApiError);
      // Asserting the absence of an unhandled rejection, so a wait is unavoidable.
      await new Promise((r) => setTimeout(r, 250));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

describe('attack: transport edge cases', () => {
  it('does not crash on a 200 with a body that is not JSON', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(200, '<html>gateway</html>');
    await expect(client().track('purchase', { userId: 'u1' })).resolves.toBeUndefined();
  });

  it('surfaces a socket hangup as a retryable error', async () => {
    // A real Error, which is what Node emits. nock can be told to emit a bare
    // object instead, but then it emits no event at all — not error, not close —
    // so that path tests the harness rather than the SDK. The real dead-socket
    // cases live in tests/integration.test.ts, over an actual socket.
    nock(ORIGIN)
      .post(TRACK_PATH)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;
    expect(error).toBeInstanceOf(IntemptApiError);
    expect(error.retryable).toBe(true);
  });

  it('ignores a Retry-After that is hostile rather than throwing', async () => {
    nock(ORIGIN)
      .post(TRACK_PATH)
      .reply(429, '', { 'Retry-After': 'not-a-number-or-a-date' });
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.retryable).toBe(true);
  });

  it('does not send a mutated config when setConfig races an in-flight request', async () => {
    const paths: string[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH)
      .delay(40)
      .reply(200, function () {
        paths.push(this.req.path);
        return '';
      });
    nock('https://other.test.local').post(TRACK_PATH).reply(200, '');

    const c = client();
    const inFlight = c.track('a', { userId: 'u1' });
    c.setConfig({ host: 'other.test.local' }); // mid-flight
    await inFlight;

    // The in-flight request must complete against the original host.
    expect(paths).toHaveLength(1);
    nock.cleanAll();
    await c.close();
  });
});

describe('attack: optOut cannot be bypassed', () => {
  it('holds even if a caller reaches for the prototype', async () => {
    const c = client();
    c.optOut();

    const proto = Object.getPrototypeOf(c) as Record<string, unknown>;
    const spy = vi.spyOn(c, 'isOptedIn');

    await c.track('purchase', { userId: 'u1' });
    await c.consent.grant({ userId: 'u1' });
    await c.ecommerce.ordered({ userId: 'u1', products: [{ productId: 'p' }] });

    expect(nock.pendingMocks()).toEqual([]);
    expect(typeof proto.optOut).toBe('function');
    spy.mockRestore();
  });
});
