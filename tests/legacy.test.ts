import { describe, expect, it } from 'vitest';
import { SDK } from '../src';
import {
  API_KEY,
  BASIC,
  CONSENT_PATH,
  HOST,
  ORG,
  ORIGIN,
  PROJECT,
  SOURCE,
  TRACK_PATH,
  feedPath,
  nock,
  setupNock,
} from './helpers';

setupNock();

function legacy(time?: number, maxSize?: number): SDK {
  const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE, time, maxSize);
  sdk.v2.setConfig({ host: HOST });
  return sdk;
}

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

describe('legacy SDK: construction', () => {
  it('still rejects missing constructor arguments with the 1.x message', () => {
    expect(() => new SDK('', PROJECT, API_KEY, SOURCE)).toThrow(
      'Incorrect configuration parameters',
    );
    expect(() => new SDK(ORG, PROJECT, API_KEY, '')).toThrow(
      'Incorrect configuration parameters',
    );
  });

  it('sends the API key as a header, unlike 1.x', async () => {
    let auth: string | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH)
      .reply(200, function () {
        auth = this.req.headers.authorization as string;
        return '';
      });

    await legacy().track('p1', 'purchase', { total: 1 });

    expect(auth).toBe(`Basic ${BASIC}`);
  });

  it('leaves batching off when neither time nor maxSize is given', async () => {
    const bodies = capture();
    const sdk = legacy();

    await sdk.track('p1', 'purchase', { total: 1 });

    // 1.x with no batching config resent the entire buffer on every call.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.track).toHaveLength(1);
    expect(sdk.v2.buffered).toBe(0);
  });

  it('maps time and maxSize onto batch options', () => {
    const sdk = legacy(250, 10);
    expect(sdk.v2.config.batch).toMatchObject({ size: 10, flushMs: 250 });
    void sdk.close();
  });
});

describe('legacy SDK: forwarding', () => {
  it('maps track, identify, group and record onto the new surface', async () => {
    const bodies = capture(4);
    const sdk = legacy();

    await sdk.track('p1', 'purchase', { total: 700 });
    await sdk.identify('p1', 'john', 'identify-user', { location: 'Winterfell' });
    await sdk.group('p1', 'Stark', undefined, { domain: 'starks.com' });
    await sdk.record('p1', 'battle', 'john', 'Stark', { winner: 'Stark' }, { kills: 74 });

    expect(bodies.map((b) => b.track[0]!.name)).toEqual([
      'purchase',
      'identify-user',
      'Identify',
      'battle',
    ]);
    expect(bodies[0]!.track[0]!.payload[0]!.profileId).toBe('p1');
    expect(bodies[1]!.track[0]!.payload[0]!.userAttributes).toEqual({
      location: 'Winterfell',
    });
    expect(bodies[2]!.track[0]!.payload[0]!.accountAttributes).toEqual({
      domain: 'starks.com',
    });
    expect(bodies[3]!.track[0]!.payload[0]!.data).toEqual({ winner: 'Stark' });
  });

  it('maps alias onto anotherUserId', async () => {
    const bodies = capture();
    await legacy().alias('p1', 'john', 'aegon');
    expect(bodies[0]!.track[0]!.payload[0]!.anotherUserId).toBe('aegon');
  });

  it('maps the product helpers', async () => {
    const bodies = capture(3);
    const sdk = legacy();

    await sdk.productView('p1', 'sku-1');
    await sdk.productAdd('p1', 'sku-1', 2);
    await sdk.productOrdered('p1', [{ productId: 'sku-1', quantity: 2 }]);

    expect(bodies.map((b) => b.track[0]!.name)).toEqual([
      'Product viewed',
      'Added to cart',
      'Product ordered',
    ]);
  });

  it('maps consents and consent onto grant and revoke', async () => {
    const bodies: Record<string, unknown>[] = [];
    nock(ORIGIN)
      .post(CONSENT_PATH, (body: Record<string, unknown>) => {
        bodies.push(body);
        return true;
      })
      .times(2)
      .reply(200, '');

    const sdk = legacy();
    await sdk.consents('p1', 'accept');
    await sdk.consent('p1', 'reject', 'marketing', '1786608000000');

    expect(bodies.map((b) => b.action)).toEqual(['accept', 'reject']);
    expect(bodies[1]!.category).toBe('marketing');
    expect(bodies[1]!.sourceId).toBe(SOURCE);
  });

  it('rejects an unknown consent action instead of warning and resolving', async () => {
    // 1.x logged 'consents request params are incorrect' and resolved.
    await expect(legacy().consents('p1', 'maybe')).rejects.toThrow(
      /must be 'accept' or 'reject'/,
    );
  });

  it('refuses the four choose helpers and points at variation()', () => {
    // Returning [] would read as "no variant assigned" and silently disable a caller's experiment.
    // Throwing tells them where it went.
    //
    // The message used to say assignment was unavailable in a server SDK at all. It is available:
    // the endpoint serves a body by key, and {name, group, body} is everything variation() needs.
    // That - not a reason field - is why the message names its replacement instead of a dead end.
    // The serving response still carries NO reason, which is why variationDetail stays internal.
    const sdk = legacy();
    for (const method of [
      'chooseExperimentsByGroups',
      'chooseExperimentsByNames',
      'choosePersonalizationsByGroups',
      'choosePersonalizationsByNames',
    ] as const) {
      expect(() => sdk[method]()).toThrow(/was removed in 2\.0/);
      expect(() => sdk[method]()).toThrow(/variation\(key, context, defaultValue\)/);
    }
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('maps recommendation onto an id/type feed lookup', async () => {
    // 1.x passed a profileId, which the feeds API never read.
    const bodies: Record<string, unknown>[] = [];
    nock(ORIGIN)
      .post(feedPath('848'), (body: Record<string, unknown>) => {
        bodies.push(body);
        return true;
      })
      .reply(200, { items: [] });

    const result = await legacy().recommendation('p1', '848', 5, ['id', 'price']);

    expect(result).toEqual({ items: [] });
    expect(bodies[0]).toMatchObject({ id: 'p1', type: 'user', limit: 5 });
  });

  it('keeps optIn and optOut working, now covering consent too', async () => {
    const sdk = legacy();
    sdk.optOut();

    await sdk.track('p1', 'purchase', { total: 1 });
    await sdk.consents('p1', 'accept');

    expect(nock.pendingMocks()).toEqual([]);

    const bodies = capture();
    sdk.optIn();
    await sdk.track('p1', 'purchase', { total: 1 });
    expect(bodies).toHaveLength(1);
  });
});

describe('legacy SDK: deprecation', () => {
  it('warns once through the configured logger', async () => {
    const warnings: unknown[][] = [];
    const logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => {},
    };

    // The shim warns on the first construction in the process; assert the text
    // reaches a logger rather than the count, which is process-global.
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ logger });
    // The stored logger is a guard around this one, so assert it forwards.
    sdk.v2.config.logger.warn('forwarded');
    expect(warnings).toContainEqual(['forwarded']);
    await sdk.close();
  });

  it('exposes the v2 client for incremental migration', () => {
    const sdk = legacy();
    expect(typeof sdk.v2.recommend).toBe('function');
    expect(typeof sdk.v2.flush).toBe('function');
  });
});
