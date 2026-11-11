import { describe, expect, it } from 'vitest';
import { SDK } from '../src';
import {
  API_KEY,
  CHOOSE_PATH,
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
 * INT-7446, CONTRACT-R2 §S5: a server SDK has no session, so it sends NO sessionId on any
 * ingestion write and never invents one. A caller-supplied sessionId is accepted on flag calls
 * only. A guard, not a fix: no write path emitted one when this was checked.
 */
describe('sessionId on the wire (INT-7446)', () => {
  function captureTrack(times: number): unknown[] {
    const bodies: unknown[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (body: unknown) => {
        bodies.push(body);
        return true;
      })
      .times(times)
      .reply(200, {});
    return bodies;
  }

  it('is absent from track, trackBatch, identify, group and ecommerce, even when passed', async () => {
    const bodies = captureTrack(5);
    const c = client();
    const sneaky = { userId: 'u1', sessionId: 'caller-session' } as never;

    await c.track('purchase', sneaky);
    await c.trackBatch([{ event: 'a', ...(sneaky as object) } as never]);
    await c.identify(sneaky);
    await c.group({ accountId: 'acc', sessionId: 'caller-session' } as never);
    await c.ecommerce.productViewed({ ...(sneaky as object), productId: 'sku' } as never);
    await c.close();

    expect(bodies).toHaveLength(5);
    expect(JSON.stringify(bodies)).not.toContain('sessionId');
  });

  it('is absent from the legacy shim track', async () => {
    const bodies = captureTrack(1);
    const legacy = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    legacy.v2.setConfig({ host: HOST, logger: testLogger() });

    await legacy.track('profile-1', 'purchase', { sessionId: 'x' });
    await legacy.close();

    expect(bodies).toHaveLength(1);
    const payload = (bodies[0] as { track: { payload: Record<string, unknown>[] }[] })
      .track[0]!.payload[0]!;
    expect(payload).not.toHaveProperty('sessionId');
  });

  it('is forwarded on a flag call when the caller supplies one', async () => {
    let sent: Record<string, unknown> | undefined;
    nock(ORIGIN)
      .post(CHOOSE_PATH, (body: Record<string, unknown>) => {
        sent = body;
        return true;
      })
      .reply(200, { choices: [] });

    const c = client();
    await c.variation('k', { userId: 'u1', sessionId: 'visit-7' }, false);
    await c.close();

    expect(sent?.sessionId).toBe('visit-7');
  });

  it('is not invented on a flag call when the caller supplies none', async () => {
    let sent: Record<string, unknown> | undefined;
    nock(ORIGIN)
      .post(CHOOSE_PATH, (body: Record<string, unknown>) => {
        sent = body;
        return true;
      })
      .reply(200, { choices: [] });

    const c = client();
    await c.variation('k', { userId: 'u1' }, false);
    await c.close();

    expect(sent).not.toHaveProperty('sessionId');
  });
});
