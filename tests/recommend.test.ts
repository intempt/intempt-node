import { describe, expect, it } from 'vitest';
import { ORIGIN, SOURCE, client, feedPath, nock, setupNock } from './helpers';

setupNock();

type Body = Record<string, unknown>;

function capture(id: string, reply: unknown = {}): Body[] {
  const bodies: Body[] = [];
  nock(ORIGIN)
    .post(feedPath(id), (body: Body) => {
      bodies.push(body);
      return true;
    })
    .reply(200, reply as never);
  return bodies;
}

describe('recommend: the feeds API identifies by {id, type}', () => {
  it('maps userId to an id/type pair, and never sends userId', async () => {
    // FeedRequest has no userId or profileId field. 1.x sent userId and it was
    // silently ignored, so the request failed with "Name is null" because no
    // entity could be resolved. Verified live against feed 5292.
    const bodies = capture('5292');

    await client().recommend({
      userId: 'luishart@inbox.example',
      feedId: '5292',
      limit: 3,
      fields: ['id', 'title'],
    });

    expect(bodies[0]).toEqual({
      id: 'luishart@inbox.example',
      type: 'user',
      sourceId: SOURCE,
      fields: ['id', 'title'],
      limit: 3,
    });
    expect(bodies[0]).not.toHaveProperty('userId');
    expect(bodies[0]).not.toHaveProperty('profileId');
  });

  it('maps accountId to type account', async () => {
    const bodies = capture('5292');
    await client().recommend({ accountId: 'acme', feedId: '5292', fields: ['id'] });
    expect(bodies[0]!.id).toBe('acme');
    expect(bodies[0]!.type).toBe('account');
  });

  it('omits limit when not given, so the API default applies', async () => {
    const bodies = capture('5292');
    await client().recommend({ userId: 'u1', feedId: '5292', fields: ['id'] });
    expect(bodies[0]).not.toHaveProperty('limit');
  });

  it('sends productId when given', async () => {
    const bodies = capture('5292');
    await client().recommend({
      userId: 'u1',
      feedId: '5292',
      fields: ['id'],
      productId: '21',
    });
    expect(bodies[0]!.productId).toBe('21');
  });

  it('returns the response body', async () => {
    capture('5292', { items: [{ id: 21 }] });
    await expect(
      client().recommend({ userId: 'u1', feedId: '5292', fields: ['id'] }),
    ).resolves.toEqual({ items: [{ id: 21 }] });
  });

  it('url-encodes the feed id', async () => {
    const scope = nock(ORIGIN).post(feedPath('a%2Fb')).reply(200, {});
    await client().recommend({ userId: 'u1', feedId: 'a/b', fields: ['id'] });
    scope.done();
  });
});

describe('recommend: validation', () => {
  it('rejects userId and accountId together', async () => {
    // The feeds API resolves one entity from one {id, type} pair, so there is no
    // meaning to both.
    await expect(
      client().recommend({ userId: 'u1', accountId: 'a1', feedId: '1', fields: ['id'] }),
    ).rejects.toThrow(/not both/);
  });

  it.each([
    ['no identifier', { feedId: '1', fields: ['id'] }, /one of userId or accountId/],
    ['no feedId', { userId: 'u1', fields: ['id'] }, /feedId is required/],
    ['empty fields', { userId: 'u1', feedId: '1', fields: [] }, /non-empty array/],
    [
      'a zero limit',
      { userId: 'u1', feedId: '1', fields: ['id'], limit: 0 },
      /positive integer/,
    ],
    [
      'a fractional limit',
      { userId: 'u1', feedId: '1', fields: ['id'], limit: 1.5 },
      /positive integer/,
    ],
  ])('rejects %s', async (_label, options, expected) => {
    await expect(client().recommend(options as never)).rejects.toThrow(expected);
  });
});

describe('experiments and personalizations are not server surface', () => {
  it('exposes no experiences method', () => {
    const c = client() as unknown as Record<string, unknown>;
    expect(c.decide).toBeUndefined();
    expect(c.experiences).toBeUndefined();
    expect(c.experiment).toBeUndefined();
    expect(c.personalization).toBeUndefined();
  });
});
