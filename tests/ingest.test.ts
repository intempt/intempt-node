import { describe, expect, it } from 'vitest';
import {
  ORIGIN,
  TRACK_PATH,
  TRACK_PATH_NO_SOURCE,
  client,
  nock,
  setupNock,
} from './helpers';

setupNock();

interface WireBody {
  track: Array<{
    name: string;
    payload: Array<Record<string, unknown>>;
  }>;
}

function capture(path = TRACK_PATH, times = 1) {
  const bodies: WireBody[] = [];
  nock(ORIGIN)
    .post(path, (body: WireBody) => {
      bodies.push(body);
      return true;
    })
    .times(times)
    .reply(200, '');
  return bodies;
}

describe('ingest: identifiers', () => {
  it('accepts userId alone, without profileId', async () => {
    // DataRequest requires one of userId / profileId / accountId and copies
    // userId into profileId server-side, so demanding profileId is wrong.
    const bodies = capture();

    await client().identify({ userId: 'user@example.com', traits: { plan: 'pro' } });

    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.userId).toBe('user@example.com');
    expect(item).not.toHaveProperty('profileId');
    expect(item.userAttributes).toEqual({ plan: 'pro' });
  });

  it('accepts accountId alone', async () => {
    const bodies = capture();
    await client().track('renewal', { accountId: 'acct-1' });
    expect(bodies[0]!.track[0]!.payload[0]!.accountId).toBe('acct-1');
  });

  it('rejects a call with no identifier at all', async () => {
    await expect(client().track('purchase', {})).rejects.toThrow(
      /one of userId or accountId/,
    );
  });

  it('does not expose profileId or masterId as public identifiers', async () => {
    // Both are platform-internal: profileId is minted by the browser SDK on the
    // device, masterId is assigned after identity resolution. A server has no
    // way to obtain either, so neither is part of the public surface.
    const bodies = capture();
    await client().identify({ userId: 'u1' });
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item).not.toHaveProperty('profileId');
    expect(item).not.toHaveProperty('masterId');
    // The platform derives profileId from userId itself.
    expect(item.userId).toBe('u1');
  });
});

describe('ingest: endpoint selection', () => {
  it('uses /sources/{id}/track when a sourceId is configured', async () => {
    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    await client().track('purchase', { userId: 'u1' });
    scope.done();
  });

  it('uses /track when no sourceId is configured', async () => {
    const scope = nock(ORIGIN).post(TRACK_PATH_NO_SOURCE).reply(200, '');
    await client({ sourceId: undefined }).track('purchase', { userId: 'u1' });
    scope.done();
  });
});

describe('ingest: wire format', () => {
  it('wraps events as { track: [{ name, payload: [...] }] }', async () => {
    const bodies = capture();

    await client().track('purchase', {
      userId: 'u1',
      properties: { total: 99.99, currency: 'USD' },
    });

    const body = bodies[0]!;
    expect(Object.keys(body)).toEqual(['track']);
    expect(body.track).toHaveLength(1);
    expect(body.track[0]!.name).toBe('purchase');
    expect(body.track[0]!.payload).toHaveLength(1);
    expect(body.track[0]!.payload[0]!.data).toEqual({ total: 99.99, currency: 'USD' });
  });

  it('generates a uuid eventId and a millisecond timestamp', async () => {
    const bodies = capture();
    const before = Date.now();

    await client().track('purchase', { userId: 'u1' });

    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(item.timestamp as number).toBeGreaterThanOrEqual(before);
  });

  it('accepts an explicit Date or epoch ms timestamp', async () => {
    const bodies = capture(TRACK_PATH, 2);
    const when = new Date('2026-01-02T03:04:05.000Z');

    const c = client();
    await c.track('a', { userId: 'u1', timestamp: when });
    await c.track('b', { userId: 'u1', timestamp: 1_767_322_445_000 });

    expect(bodies[0]!.track[0]!.payload[0]!.timestamp).toBe(when.getTime());
    expect(bodies[1]!.track[0]!.payload[0]!.timestamp).toBe(1_767_322_445_000);
  });

  it('rejects an invalid timestamp instead of silently sending now', async () => {
    await expect(
      client().track('purchase', { userId: 'u1', timestamp: new Date('nope') }),
    ).rejects.toThrow(/valid Date or epoch milliseconds/);
  });

  it('omits undefined fields entirely', async () => {
    const bodies = capture();
    await client().track('purchase', { userId: 'u1' });
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(Object.keys(item).sort()).toEqual(['eventId', 'timestamp', 'userId']);
  });

  it('never adds $lib fields to the payload; identity is a header only', async () => {
    // A new payload field could alter a downstream event schema. The version
    // travels in X-Intempt-Lib, which cannot.
    const bodies = capture();
    await client().track('purchase', { userId: 'u1' });
    const item = bodies[0]!.track[0]!.payload[0]!;
    expect(item).not.toHaveProperty('$lib');
    expect(item).not.toHaveProperty('$libVersion');
  });
});

describe('ingest: reserved names', () => {
  it('refuses to let track() impersonate Identify', async () => {
    await expect(client().track('Identify', { userId: 'u1' })).rejects.toThrow(
      /reserved/,
    );
  });

  it('uses Identify for identify and group', async () => {
    const bodies = capture(TRACK_PATH, 2);
    const c = client();
    await c.identify({ userId: 'u1' });
    await c.group({ userId: 'u1', accountId: 'a1' });

    expect(bodies.map((b) => b.track[0]!.name)).toEqual(['Identify', 'Identify']);
  });

  it('allows an explicit event name on identify and group', async () => {
    const bodies = capture(TRACK_PATH, 2);
    const c = client();
    await c.identify({ userId: 'u1', event: 'signed up' });
    await c.group({ userId: 'u1', accountId: 'a1', event: 'joined org' });

    expect(bodies.map((b) => b.track[0]!.name)).toEqual(['signed up', 'joined org']);
  });
});

describe('ingest: group', () => {
  it('requires accountId', async () => {
    await expect(client().group({ userId: 'u1' } as never)).rejects.toThrow(
      /accountId must be a non-empty string/,
    );
  });

  it('sends attributes as accountAttributes', async () => {
    const bodies = capture();
    await client().group({
      userId: 'u1',
      accountId: 'a1',
      attributes: { domain: 'acme.com' },
    });
    expect(bodies[0]!.track[0]!.payload[0]!.accountAttributes).toEqual({
      domain: 'acme.com',
    });
  });
});

describe('ingest: trackBatch', () => {
  it('sends one request when the batch fits', async () => {
    const bodies = capture();
    await client().trackBatch([
      { event: 'a', userId: 'u1' },
      { event: 'b', userId: 'u2' },
    ]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.track).toHaveLength(2);
  });

  it('chunks so one call never becomes one oversized request', async () => {
    const bodies = capture(TRACK_PATH, 3);
    const events = Array.from({ length: 25 }, (_, i) => ({
      event: `e${i}`,
      userId: 'u1',
    }));

    await client({ maxRequestEvents: 10 }).trackBatch(events);

    expect(bodies.map((b) => b.track.length)).toEqual([10, 10, 5]);
  });

  it('defaults the chunk ceiling to 50', async () => {
    expect(client().config.maxRequestEvents).toBe(50);
  });

  it('does nothing for an empty array', async () => {
    await client().trackBatch([]);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('validates every entry before sending anything', async () => {
    await expect(
      client().trackBatch([
        { event: 'a', userId: 'u1' },
        { event: '', userId: 'u2' },
      ]),
    ).rejects.toThrow(/trackBatch\[1\]: event name is required/);
    expect(nock.pendingMocks()).toEqual([]);
  });
});
