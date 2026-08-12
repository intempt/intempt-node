import { describe, expect, it } from 'vitest';
import { CONSENT_PATH, ORIGIN, SOURCE, client, nock, setupNock } from './helpers';

setupNock();

type Body = Record<string, unknown>;

function capture(times = 1): Body[] {
  const bodies: Body[] = [];
  nock(ORIGIN)
    .post(CONSENT_PATH, (body: Body) => {
      bodies.push(body);
      return true;
    })
    .times(times)
    .reply(200, '');
  return bodies;
}

describe('consent: timestamp units', () => {
  it('sends epoch SECONDS, not milliseconds', async () => {
    // ConsentService compares `timestamp * 1000` against millisecond bounds
    // (DataUtils.UP_TIMESTAMP_LIMIT / LOW_TIMESTAMP_LIMIT), so this field is
    // seconds. Sending ms makes the server discard the value and substitute
    // its own receive time, which is what 1.x did.
    const bodies = capture();
    const when = new Date('2026-08-12T10:00:00.000Z');

    await client().consent.grant({ userId: 'u1', timestamp: when });

    expect(bodies[0]!.timestamp).toBe(Math.floor(when.getTime() / 1000));
    expect(bodies[0]!.timestamp).toBeLessThan(2_216_872_268);
  });

  it('defaults to now, in seconds', async () => {
    const bodies = capture();
    const nowSeconds = Math.floor(Date.now() / 1000);

    await client().consent.grant({ userId: 'u1' });

    const sent = bodies[0]!.timestamp as number;
    expect(sent).toBeGreaterThanOrEqual(nowSeconds - 2);
    expect(sent).toBeLessThanOrEqual(nowSeconds + 2);
  });

  it('rejects a timestamp the server would refuse as too low', async () => {
    await expect(
      client().consent.grant({
        userId: 'u1',
        timestamp: new Date('2009-12-31T00:00:00Z'),
      }),
    ).rejects.toThrow(/below the API threshold/);
  });
});

describe('consent: identifiers', () => {
  it('accepts userId alone, with no sourceId needed', async () => {
    const bodies = capture();
    await client({ sourceId: undefined }).consent.grant({ userId: 'u1' });

    expect(bodies[0]!.userId).toBe('u1');
    expect(bodies[0]).not.toHaveProperty('sourceId');
  });

  it('never rounds a 19-digit snowflake sourceId through Number()', async () => {
    // A real source id: 19 digits, past Number.MAX_SAFE_INTEGER. Number() would
    // turn it into ...048800 and address a different source. The API declares
    // sourceId with LongFromStringDeserializer, so a string is correct.
    const realSourceId = '1841503112918048768';
    const bodies = capture();

    await client({ sourceId: realSourceId }).consent.grant({ profileId: 'p1' } as never);

    expect(bodies[0]!.sourceId).toBe(realSourceId);
    expect(String(bodies[0]!.sourceId)).not.toBe('1841503112918048800');
  });

  it('sends sourceId when identifying by profileId', async () => {
    // ConsentService: "Source is required for profileId".
    const bodies = capture();
    await client().consent.grant({ profileId: 'p1' } as never);

    expect(bodies[0]!.profileId).toBe('p1');
    expect(bodies[0]!.sourceId).toBe(SOURCE);
  });

  it('refuses a profileId consent when no sourceId is configured', async () => {
    await expect(
      client({ sourceId: undefined }).consent.grant({ profileId: 'p1' } as never),
    ).rejects.toThrow(/sourceId must be configured/);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('requires userId', async () => {
    await expect(client().consent.grant({})).rejects.toThrow(
      /userId must be a non-empty string/,
    );
  });

  it('does not accept masterId — an internal id no caller can resolve', async () => {
    // Typed out of ConsentOptions; also rejected at runtime because it is not
    // an identifier assertIdentifier recognises.
    await expect(client().consent.grant({ masterId: '123' } as never)).rejects.toThrow(
      /userId must be a non-empty string/,
    );
  });
});

describe('consent: body', () => {
  it('uses the accept and reject actions the API enum defines', async () => {
    const bodies = capture(2);
    const c = client();
    await c.consent.grant({ userId: 'u1' });
    await c.consent.revoke({ userId: 'u1' });

    expect(bodies.map((b) => b.action)).toEqual(['accept', 'reject']);
  });

  it('always sends the required action, timestamp, validUntil and source', async () => {
    const bodies = capture();
    await client().consent.grant({ userId: 'u1' });

    // ConsentService.validate rejects a record missing any of these four.
    for (const field of ['action', 'timestamp', 'validUntil', 'source']) {
      expect(bodies[0], field).toHaveProperty(field);
    }
    expect(bodies[0]!.validUntil).toBe('unlimited');
    expect(bodies[0]!.source).toBe('NodeJs tracker');
  });

  it('passes category and the optional descriptive fields through', async () => {
    const bodies = capture();
    await client().consent.revoke({
      userId: 'u1',
      category: 'marketing',
      validUntil: '1786608000000',
      email: 'u1@example.com',
      message: 'unsubscribed from footer link',
      reason: 'user request',
      method: 'API',
      deviceInfo: 'server',
    });

    expect(bodies[0]).toMatchObject({
      action: 'reject',
      category: 'marketing',
      validUntil: '1786608000000',
      email: 'u1@example.com',
      message: 'unsubscribed from footer link',
      reason: 'user request',
      method: 'API',
      deviceInfo: 'server',
    });
  });

  it('omits fields the caller did not set', async () => {
    const bodies = capture();
    await client({ sourceId: undefined }).consent.grant({ userId: 'u1' });

    expect(Object.keys(bodies[0]!).sort()).toEqual([
      'action',
      'source',
      'timestamp',
      'userId',
      'validUntil',
    ]);
  });
});
