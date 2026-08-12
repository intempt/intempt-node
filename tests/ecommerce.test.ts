import { describe, expect, it } from 'vitest';
import { COMMERCE_EVENTS } from '../src';
import { ORIGIN, TRACK_PATH, client, nock, setupNock } from './helpers';

setupNock();

interface WireBody {
  track: Array<{ name: string; payload: Array<Record<string, unknown>> }>;
}

function capture(times = 1): WireBody[] {
  const bodies: WireBody[] = [];
  nock(ORIGIN)
    .post(TRACK_PATH, (body: WireBody) => {
      bodies.push(body);
      return true;
    })
    .times(times)
    .reply(200, '');
  return bodies;
}

describe('ecommerce: reserved names', () => {
  it('uses the names the platform recognises', () => {
    expect(COMMERCE_EVENTS).toEqual({
      productViewed: 'Product viewed',
      addedToCart: 'Added to cart',
      ordered: 'Product ordered',
    });
  });

  it('sends each name on the wire', async () => {
    const bodies = capture(3);
    const c = client();

    await c.ecommerce.productViewed({ userId: 'u1', productId: 'p1' });
    await c.ecommerce.addedToCart({ userId: 'u1', productId: 'p1', quantity: 2 });
    await c.ecommerce.ordered({ userId: 'u1', products: [{ productId: 'p1', quantity: 1 }] });

    expect(bodies.map((b) => b.track[0]!.name)).toEqual([
      'Product viewed',
      'Added to cart',
      'Product ordered',
    ]);
  });
});

describe('ecommerce: 1.x wire parity', () => {
  it('puts each product on its own payload item under data', async () => {
    const bodies = capture();

    await client().ecommerce.ordered({
      userId: 'u1',
      products: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ],
    });

    const payload = bodies[0]!.track[0]!.payload;
    expect(payload).toHaveLength(2);
    expect(payload[0]!.data).toEqual({ productId: 'p1', quantity: 2 });
    expect(payload[1]!.data).toEqual({ productId: 'p2', quantity: 1 });
  });

  it('shares one eventId across the lines, as 1.x productTrack did', async () => {
    // Preserved deliberately. Per-line dedup cannot tell the lines apart, which
    // is odd, but changing it would change ingestion semantics.
    const bodies = capture();

    await client().ecommerce.ordered({
      userId: 'u1',
      products: [{ productId: 'p1' }, { productId: 'p2' }, { productId: 'p3' }],
    });

    const ids = bodies[0]!.track[0]!.payload.map((item) => item.eventId);
    expect(new Set(ids).size).toBe(1);
  });

  it('shares one timestamp across the lines', async () => {
    const bodies = capture();
    await client().ecommerce.ordered({
      userId: 'u1',
      products: [{ productId: 'p1' }, { productId: 'p2' }],
    });
    const stamps = bodies[0]!.track[0]!.payload.map((item) => item.timestamp);
    expect(new Set(stamps).size).toBe(1);
  });

  it('omits quantity when a line has none', async () => {
    const bodies = capture();
    await client().ecommerce.productViewed({ userId: 'u1', productId: 'p1' });
    expect(bodies[0]!.track[0]!.payload[0]!.data).toEqual({ productId: 'p1' });
  });
});

describe('ecommerce: validation', () => {
  it('rejects a missing productId', async () => {
    const c = client();
    await expect(c.ecommerce.productViewed({ userId: 'u1' } as never)).rejects.toThrow(
      /productId is required/,
    );
    await expect(
      c.ecommerce.addedToCart({ userId: 'u1', quantity: 1 } as never),
    ).rejects.toThrow(/productId is required/);
  });

  it.each([0, -1, Number.NaN])('rejects a quantity of %j', async (quantity) => {
    await expect(
      client().ecommerce.addedToCart({ userId: 'u1', productId: 'p1', quantity }),
    ).rejects.toThrow(/quantity must be a positive number/);
  });

  it('rejects an empty or non-array products list', async () => {
    const c = client();
    await expect(c.ecommerce.ordered({ userId: 'u1', products: [] })).rejects.toThrow(
      /non-empty array/,
    );
    await expect(
      c.ecommerce.ordered({ userId: 'u1', products: 'p1' as never }),
    ).rejects.toThrow(/non-empty array/);
  });

  it('names the offending index in a bad products list', async () => {
    await expect(
      client().ecommerce.ordered({
        userId: 'u1',
        products: [{ productId: 'p1' }, { productId: '' }],
      }),
    ).rejects.toThrow(/products\[1\]\.productId is required/);

    await expect(
      client().ecommerce.ordered({
        userId: 'u1',
        products: [{ productId: 'p1', quantity: -3 }],
      }),
    ).rejects.toThrow(/products\[0\]\.quantity/);
  });

  it('requires an identifier', async () => {
    await expect(
      client().ecommerce.productViewed({ productId: 'p1' }),
    ).rejects.toThrow(/one of userId/);
  });

  it('rejects instead of returning { error: true } like 1.x', async () => {
    const result = await client()
      .ecommerce.productViewed({ userId: 'u1' } as never)
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    expect(result).toBe('rejected');
  });
});
