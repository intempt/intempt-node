import { describe, expect, it } from 'vitest';
import {
  CHOOSE_PATH,
  ORIGIN,
  SOURCE,
  client,
  feedPath,
  nock,
  setupNock,
} from './helpers';

setupNock();

type Body = Record<string, any>;

function captureChoose(times = 1, reply: unknown = { choices: [] }): Body[] {
  const bodies: Body[] = [];
  nock(ORIGIN)
    .post(CHOOSE_PATH, (body: Body) => {
      bodies.push(body);
      return true;
    })
    .times(times)
    .reply(200, reply as never);
  return bodies;
}

describe('decide.experiences', () => {
  it('serves both optimization types from one endpoint', async () => {
    const bodies = captureChoose(2);
    const c = client();

    await c.decide.experiences({ userId: 'u1', type: 'experiment', names: ['test-1'] });
    await c.decide.experiences({ userId: 'u1', type: 'personalization', groups: ['g1'] });

    expect(bodies.map((b) => b.optimizationType)).toEqual([
      'experiment',
      'personalization',
    ]);
    expect(bodies[0]!.names).toEqual(['test-1']);
    expect(bodies[1]!.groups).toEqual(['g1']);
  });

  it('returns the choices array from the response', async () => {
    captureChoose(1, { choices: [{ name: 'variant-b' }] });
    const choices = await client().decide.experiences({
      userId: 'u1',
      type: 'experiment',
    });
    expect(choices).toEqual([{ name: 'variant-b' }]);
  });

  it('returns an empty array when the response carries no choices', async () => {
    captureChoose(1, {});
    await expect(
      client().decide.experiences({ userId: 'u1', type: 'experiment' }),
    ).resolves.toEqual([]);
  });

  it('nests identification and defaults device to all', async () => {
    const bodies = captureChoose();
    await client().decide.experiences({ userId: 'u1', type: 'experiment' });

    // Verified live — a userId-only identification returns HTTP 200.
    // No profileId: the platform resolves identity from userId on its own.
    expect(bodies[0]!.identification).toEqual({
      userId: 'u1',
      sourceId: SOURCE,
    });
    expect(bodies[0]!.device).toBe('all');
  });

  it('carries profileId only when the deprecated shim supplies it', async () => {
    const bodies = captureChoose();
    await client().decide.experiences({
      userId: 'u1',
      profileId: 'p1',
      type: 'experiment',
    });
    expect(bodies[0]!.identification.profileId).toBe('p1');
  });

  it('rejects an unknown type', async () => {
    await expect(
      client().decide.experiences({ userId: 'u1', type: 'nope' as never }),
    ).rejects.toThrow(/must be 'experiment' or 'personalization'/);
  });

  it('accepts names and groups together, and either alone, and neither', async () => {
    // Both are optional: ExperienceApiChooseRequest marks only `identification`
    // as @NotNull. Verified live that all four combinations return 200.
    const bodies = captureChoose(4);
    const c = client();
    await c.decide.experiences({ userId: 'u1', type: 'experiment' });
    await c.decide.experiences({ userId: 'u1', type: 'experiment', names: ['n_1'] });
    await c.decide.experiences({ userId: 'u1', type: 'experiment', groups: ['g-1'] });
    await c.decide.experiences({
      userId: 'u1',
      type: 'experiment',
      names: ['n_1'],
      groups: ['g-1'],
    });

    expect(bodies[0]).not.toHaveProperty('names');
    expect(bodies[0]).not.toHaveProperty('groups');
    expect(bodies[1]!.names).toEqual(['n_1']);
    expect(bodies[2]!.groups).toEqual(['g-1']);
    expect(bodies[3]!.names).toEqual(['n_1']);
    expect(bodies[3]!.groups).toEqual(['g-1']);
  });

  it.each([
    ['a space', 'my test'],
    ['a dot', 'my.test'],
    ['a slash', 'a/b'],
  ])('rejects a name containing %s before the API does', async (_label, name) => {
    // The API answers 400 {"errors":[{"message":"must match \"^[a-zA-Z0-9_-]*$\""}]}
    // which does not say which value was wrong. Ours does.
    await expect(
      client().decide.experiences({ userId: 'u1', type: 'experiment', names: [name] }),
    ).rejects.toThrow(/is invalid; the API allows only letters, digits/);
  });

  it('applies the same pattern to groups', async () => {
    await expect(
      client().decide.experiences({
        userId: 'u1',
        type: 'experiment',
        groups: ['bad group'],
      }),
    ).rejects.toThrow(/groups entry "bad group" is invalid/);
  });

  it('requires an identifier', async () => {
    await expect(client().decide.experiences({ type: 'experiment' })).rejects.toThrow(
      /one of userId/,
    );
  });
});

describe('decide.recommend', () => {
  it('posts to the feed and returns the body', async () => {
    const bodies: Body[] = [];
    nock(ORIGIN)
      .post(feedPath('848'), (body: Body) => {
        bodies.push(body);
        return true;
      })
      .reply(200, { items: [{ id: 1 }] });

    const result = await client().decide.recommend({
      userId: 'u1',
      feedId: '848',
      limit: 5,
      fields: ['id', 'price', 'title'],
    });

    expect(result).toEqual({ items: [{ id: 1 }] });
    expect(bodies[0]).toEqual({
      userId: 'u1',
      sourceId: SOURCE,
      fields: ['id', 'price', 'title'],
      limit: 5,
    });
  });

  it('sends productId when given', async () => {
    const bodies: Body[] = [];
    nock(ORIGIN)
      .post(feedPath('848'), (body: Body) => {
        bodies.push(body);
        return true;
      })
      .reply(200, {});

    await client().decide.recommend({
      userId: 'u1',
      feedId: '848',
      limit: 1,
      fields: ['id'],
      productId: 'p9',
    });

    expect(bodies[0]!.productId).toBe('p9');
  });

  it('url-encodes the feed id', async () => {
    const scope = nock(ORIGIN).post(feedPath('a%2Fb')).reply(200, {});
    await client().decide.recommend({
      userId: 'u1',
      feedId: 'a/b',
      limit: 1,
      fields: ['id'],
    });
    scope.done();
  });

  it.each([
    [
      'a missing feedId',
      { userId: 'u1', limit: 1, fields: ['id'] },
      /feedId is required/,
    ],
    [
      'empty fields',
      { userId: 'u1', feedId: '1', limit: 1, fields: [] },
      /non-empty array/,
    ],
    [
      'a zero limit',
      { userId: 'u1', feedId: '1', limit: 0, fields: ['id'] },
      /positive integer/,
    ],
    [
      'a fractional limit',
      { userId: 'u1', feedId: '1', limit: 1.5, fields: ['id'] },
      /positive integer/,
    ],
  ])('rejects %s', async (_label, options, expected) => {
    await expect(client().decide.recommend(options as never)).rejects.toThrow(expected);
  });
});
