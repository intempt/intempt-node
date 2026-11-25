import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLAG_ALL_PATH,
  FLAG_EXPOSE_PATH,
  ORIGIN,
  SOURCE,
  client,
  nock,
  setupNock,
  testLogger,
  waitFor,
} from './helpers';
import { IntemptFlags } from '../src/flags';
import { API_KEY, HOST, ORG, PROJECT } from './helpers';

setupNock();

/**
 * F32 hybrid exposure (Beso, 2026-11-17): `/flags/all` publishes nothing, so the SDK reports the
 * exposure the first time code reads each flag from the prefetched set, through
 * `POST /flags/expose {identification, key, variationId}`. Example from the ticket: a page loads
 * 12 flags and reads only new-checkout -> one exposure, for new-checkout.
 */
const SERVED = {
  flags: Array.from({ length: 12 }, (_, i) => ({
    key: i === 0 ? 'new-checkout' : `flag-${i}`,
    value: i % 2 === 0,
    variationId: 100 + i,
    valueType: 'boolean',
    reason: 'targeted',
  })),
};

type Body = Record<string, unknown>;

function exposeRecorder(reply: (b: Body) => nock.ReplyFnResult = () => [202, '']) {
  const sent: Body[] = [];
  nock(ORIGIN)
    .post(FLAG_EXPOSE_PATH, (b) => {
      sent.push(b as Body);
      return true;
    })
    .times(50)
    .reply(function (_uri, b) {
      return reply(b as Body);
    });
  return sent;
}

/** Lets any fire-and-forget request leave and land before asserting nothing more was sent. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('allFlags reports an exposure on first read (F32, /flags/expose)', () => {
  afterEach(() => nock.cleanAll());

  it('reading one of 12 prefetched flags records one exposure, for that flag', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, SERVED);
    const sent = exposeRecorder();
    const c = client();
    const flags = await c.allFlags({ userId: 'u-1', sessionId: 's-1' } as never);
    expect(sent).toHaveLength(0);

    expect(flags['new-checkout']).toBe(true);
    await waitFor(() => sent.length === 1);
    await settle();
    expect(sent).toEqual([
      {
        identification: { userId: 'u-1', sourceId: SOURCE },
        device: 'all',
        key: 'new-checkout',
        variationId: 100,
      },
    ]);
    expect(JSON.stringify(sent[0])).not.toMatch(/masterId|sessionId|exposure/);
    await c.close();
  });

  it('records once per key per returned set; a new allFlags set records again', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).times(2).reply(200, SERVED);
    const sent = exposeRecorder();
    const c = client();
    const first = await c.allFlags({ userId: 'u-1' });
    void first['new-checkout'];
    void first['new-checkout'];
    void first['flag-3'];
    void first['flag-3'];
    await waitFor(() => sent.length === 2);
    await settle();
    expect(sent.map((b) => [b.key, b.variationId])).toEqual([
      ['new-checkout', 100],
      ['flag-3', 103],
    ]);

    const second = await c.allFlags({ userId: 'u-1' });
    void second['new-checkout'];
    await waitFor(() => sent.length === 3);
    expect(sent[2]).toMatchObject({ key: 'new-checkout', variationId: 100 });
    await c.close();
  });

  it('sends profileId + sourceId when the context names a profile', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, SERVED);
    const sent = exposeRecorder();
    const c = client();
    const flags = await c.allFlags({ profileId: 'p-1' });
    void flags['flag-1'];
    await waitFor(() => sent.length === 1);
    expect(sent[0]?.identification).toEqual({ profileId: 'p-1', sourceId: SOURCE });
    await c.close();
  });

  it('listing keys or testing presence records nothing', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, SERVED);
    const sent = exposeRecorder();
    const c = client();
    const flags = await c.allFlags({ userId: 'u-1' });
    expect(Object.keys(flags)).toHaveLength(12);
    expect('new-checkout' in flags).toBe(true);
    void flags['absent-key'];
    await settle();
    expect(sent).toHaveLength(0);
    await c.close();
  });

  it('a flag served nothing, or without a variationId, records nothing', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, {
        flags: [
          { key: 'off', value: null, reason: 'off' },
          { key: 'no-variation', value: true },
        ],
      });
    const sent = exposeRecorder();
    const c = client();
    const flags = await c.allFlags({ userId: 'u-1' });
    expect(flags.off).toBeNull();
    expect(flags['no-variation']).toBe(true);
    await settle();
    expect(sent).toHaveLength(0);
    await c.close();
  });

  it('a failed expose never throws, never reaches onFlagError, and the read is not blocked', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, SERVED);
    nock(ORIGIN).post(FLAG_EXPOSE_PATH).delay(200).reply(500, 'boom');
    nock(ORIGIN).post(FLAG_EXPOSE_PATH).replyWithError('socket hang up');
    const onFlagError = vi.fn();
    const logger = testLogger();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const c = client({ onFlagError, logger });
    const flags = await c.allFlags({ userId: 'u-1' });

    expect(flags['new-checkout']).toBe(true);
    expect(flags['flag-1']).toBe(false);
    await waitFor(() => nock.isDone(), { timeoutMs: 2_000 });
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(onFlagError).not.toHaveBeenCalled();
    expect(logger.calls.error).toHaveLength(0);
    await c.close();
  });

  it('is bounded by flagTimeout', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, SERVED);
    const scope = nock(ORIGIN).post(FLAG_EXPOSE_PATH).delay(1_000).reply(202, '');
    const logger = testLogger();
    const c = client({ flagTimeout: 50, logger });
    const flags = await c.allFlags({ userId: 'u-1' });
    void flags['new-checkout'];
    await waitFor(() => logger.calls.warn.length > 0 || logger.calls.debug.length > 0, {
      timeoutMs: 800,
    });
    expect(scope.isDone()).toBe(true);
    await c.close();
  });

  it('the standalone flags entry reports exposures the same way', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(200, SERVED);
    const sent = exposeRecorder();
    const f = IntemptFlags.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: HOST,
      logger: testLogger(),
    });
    const flags = await f.allFlags({ userId: 'u-1' });
    void flags['flag-2'];
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ key: 'flag-2', variationId: 102 });
    await f.close();
  });
});
