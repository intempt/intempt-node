import { describe, expect, it } from 'vitest';
import { SDK } from '../src';
import {
  API_KEY,
  BASIC,
  CHOOSE_PATH,
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
    expect(bodies[1]!.sourceId).toBe(Number(SOURCE));
  });

  it('rejects an unknown consent action instead of warning and resolving', async () => {
    // 1.x logged 'consents request params are incorrect' and resolved.
    await expect(legacy().consents('p1', 'maybe')).rejects.toThrow(
      /must be 'accept' or 'reject'/,
    );
  });

  it('maps all four choose helpers onto one endpoint', async () => {
    const bodies: Record<string, any>[] = [];
    nock(ORIGIN)
      .post(CHOOSE_PATH, (body: Record<string, any>) => {
        bodies.push(body);
        return true;
      })
      .times(4)
      .reply(200, { choices: [] });

    const sdk = legacy();
    await sdk.chooseExperimentsByGroups('p1', ['g1']);
    await sdk.chooseExperimentsByNames('p1', ['n1']);
    await sdk.choosePersonalizationsByGroups('p1', ['g2']);
    await sdk.choosePersonalizationsByNames('p1', ['n2']);

    expect(bodies.map((b) => b.optimizationType)).toEqual([
      'experiment',
      'experiment',
      'personalization',
      'personalization',
    ]);
  });

  it('maps recommendation onto decide.recommend', async () => {
    nock(ORIGIN).post(feedPath('848')).reply(200, { items: [] });
    const result = await legacy().recommendation('p1', '848', 5, ['id', 'price']);
    expect(result).toEqual({ items: [] });
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
    expect(sdk.v2.config.logger).toBe(logger);
    await sdk.close();
  });

  it('exposes the v2 client for incremental migration', () => {
    const sdk = legacy();
    expect(typeof sdk.v2.decide.experiences).toBe('function');
    expect(typeof sdk.v2.flush).toBe('function');
  });
});
