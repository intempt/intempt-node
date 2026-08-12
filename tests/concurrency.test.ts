import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
import { Intempt, IntemptApiError } from '../src';
import {
  API_KEY,
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

function events(count: number) {
  return Array.from({ length: count }, (_, i) => ({ event: `e${i}`, userId: 'u1' }));
}

/** Tracks how many requests are in flight at the same moment. */
function concurrencyProbe(times: number, delayMs = 40) {
  const state = { inFlight: 0, peak: 0, completed: 0 };
  nock(ORIGIN)
    .post(TRACK_PATH)
    .times(times)
    .delay(delayMs)
    .reply(200, () => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      return '';
    })
    .on('replied', () => {
      state.inFlight -= 1;
      state.completed += 1;
    });
  return state;
}

describe('trackBatch concurrency', () => {
  it('is sequential by default', async () => {
    expect(client().config.maxConcurrentRequests).toBe(1);

    const probe = concurrencyProbe(4);
    await client({ maxRequestEvents: 1 }).trackBatch(events(4));

    expect(probe.completed).toBe(4);
    expect(probe.peak).toBe(1);
  });

  it('runs up to maxConcurrentRequests in flight when raised', async () => {
    const probe = concurrencyProbe(8);
    await client({ maxRequestEvents: 1, maxConcurrentRequests: 4 }).trackBatch(events(8));

    expect(probe.completed).toBe(8);
    expect(probe.peak).toBeGreaterThan(1);
    expect(probe.peak).toBeLessThanOrEqual(4);
  });

  it('never exceeds the cap even when the batch is much larger', async () => {
    const probe = concurrencyProbe(20, 10);
    await client({ maxRequestEvents: 1, maxConcurrentRequests: 3 }).trackBatch(
      events(20),
    );

    expect(probe.completed).toBe(20);
    expect(probe.peak).toBeLessThanOrEqual(3);
  });

  it('does not spawn more workers than there are chunks', async () => {
    const probe = concurrencyProbe(2, 10);
    await client({ maxRequestEvents: 1, maxConcurrentRequests: 16 }).trackBatch(
      events(2),
    );

    expect(probe.completed).toBe(2);
    expect(probe.peak).toBeLessThanOrEqual(2);
  });

  it('sends every chunk exactly once, with no gaps or duplicates', async () => {
    const seen: string[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (body: { track: Array<{ name: string }> }) => {
        seen.push(...body.track.map((t) => t.name));
        return true;
      })
      .times(5)
      .reply(200, '');

    await client({ maxRequestEvents: 2, maxConcurrentRequests: 3 }).trackBatch(
      events(10),
    );

    expect(seen.sort()).toEqual(
      events(10)
        .map((e) => e.event)
        .sort(),
    );
  });

  it('rejects with the first failure and awaits its siblings', async () => {
    // A rejection must not leave sibling requests unawaited; an unhandled
    // rejection would take the host process down under Node's default policy.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    nock(ORIGIN).post(TRACK_PATH).times(2).delay(20).reply(500, '');
    nock(ORIGIN).post(TRACK_PATH).times(2).delay(20).reply(200, '');

    try {
      await expect(
        client({ maxRequestEvents: 1, maxConcurrentRequests: 4 }).trackBatch(events(4)),
      ).rejects.toThrow(/responded 500/);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('rejects an invalid maxConcurrentRequests', () => {
    const base = { org: ORG, project: PROJECT, apiKey: API_KEY, logger: testLogger() };
    expect(() => Intempt.init({ ...base, maxConcurrentRequests: 0 })).toThrow(
      /maxConcurrentRequests/,
    );
    expect(() => Intempt.init({ ...base, maxConcurrentRequests: 2.5 })).toThrow(
      /maxConcurrentRequests/,
    );
  });
});

describe('custom agent injection', () => {
  it('uses a caller-supplied agent verbatim', async () => {
    // The escape hatch for mTLS, a private CA, or an explicit proxy policy.
    const agent = new https.Agent({ keepAlive: false });

    const scope = nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    const c = Intempt.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: 'api.test.local',
      logger: testLogger(),
      agent,
    });

    expect(c.config.agent).toBe(agent);
    await c.track('purchase', { userId: 'u1' });
    scope.done();

    await c.close();
  });

  it('must match the protocol: an http.Agent on an https client fails loudly', async () => {
    // Worth pinning, because the failure is confusing — an http.Agent dials
    // port 80 for an https request rather than erroring on the mismatch.
    const c = Intempt.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: 'api.test.local',
      logger: testLogger(),
      agent: new http.Agent(),
    });

    nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    await expect(c.track('purchase', { userId: 'u1' })).rejects.toThrow(IntemptApiError);
    await c.close();
  });

  it('leaves a caller-supplied agent alive after close', async () => {
    const agent = new http.Agent({ keepAlive: true });
    const c = Intempt.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      host: 'api.test.local',
      logger: testLogger(),
      agent,
    });

    await c.close();

    // destroy() must not tear down an agent the caller owns and may reuse.
    expect(agent.destroyed).toBeFalsy();
  });
});
