import { afterEach, describe, expect, it } from 'vitest';
import {
  FLAG_ALL_PATH,
  FLAG_EVALUATE_PATH,
  ORIGIN,
  client,
  nock,
  setupNock,
} from './helpers';

setupNock();

/**
 * Evaluation is separated from exposure by ROUTE (F32 hybrid exposure, Beso 2026-11-17):
 * `/flags/evaluate` records the exposure on the server, `/flags/all` publishes nothing. A single
 * read records unless the caller opts out; an opted-out read and `allFlags` go to `/flags/all`.
 * Neither route has an `exposure` field, so the SDK never sends one.
 */
const ctx = { userId: 'u-1' };
const opt = { disableExposure: true };

type Sent = { path: string; body: Record<string, unknown> };

async function sentBy(
  call: (c: ReturnType<typeof client>) => Promise<unknown>,
): Promise<Sent> {
  let sent: Sent = { path: '', body: {} };
  nock(ORIGIN)
    .post(FLAG_EVALUATE_PATH, (b) => {
      sent = { path: FLAG_EVALUATE_PATH, body: b as Record<string, unknown> };
      return true;
    })
    .reply(200, { key: 'k', value: true });
  nock(ORIGIN)
    .post(FLAG_ALL_PATH, (b) => {
      sent = { path: FLAG_ALL_PATH, body: b as Record<string, unknown> };
      return true;
    })
    .reply(200, { flags: [{ key: 'k', value: true }] });

  const c = client();
  await call(c);
  await c.close();
  return sent;
}

describe('exposure is chosen by route', () => {
  afterEach(() => nock.cleanAll());

  it('allFlags reads /flags/all, which publishes nothing', async () => {
    const { path, body } = await sentBy((c) => c.allFlags(ctx));
    expect(path).toBe(FLAG_ALL_PATH);
    expect('exposure' in body).toBe(false);
  });

  it('a single read records: /flags/evaluate, no exposure field', async () => {
    const { path, body } = await sentBy((c) => c.variation('k', ctx, false));
    expect(path).toBe(FLAG_EVALUATE_PATH);
    expect('exposure' in body).toBe(false);
  });

  it('disableExposure: false is the same as omitting it', async () => {
    const { path } = await sentBy((c) =>
      c.variation('k', ctx, false, { disableExposure: false }),
    );
    expect(path).toBe(FLAG_EVALUATE_PATH);
  });

  it.each([
    ['variation', (c: ReturnType<typeof client>) => c.variation('k', ctx, false, opt)],
    [
      'variationDetail',
      (c: ReturnType<typeof client>) => c.variationDetail('k', ctx, false, opt),
    ],
    [
      'boolVariation',
      (c: ReturnType<typeof client>) => c.boolVariation('k', ctx, false, opt),
    ],
    [
      'stringVariation',
      (c: ReturnType<typeof client>) => c.stringVariation('k', ctx, 'd', opt),
    ],
    [
      'numberVariation',
      (c: ReturnType<typeof client>) => c.numberVariation('k', ctx, 0, opt),
    ],
    [
      'jsonVariation',
      (c: ReturnType<typeof client>) => c.jsonVariation('k', ctx, {}, opt),
    ],
  ])(
    '%s with disableExposure reads /flags/all with only that key',
    async (_name, call) => {
      const { path, body } = await sentBy(call);
      expect(path).toBe(FLAG_ALL_PATH);
      expect(body.keys).toEqual(['k']);
      expect('exposure' in body).toBe(false);
    },
  );

  it('opting out of the exposure still returns the served value', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, { flags: [{ key: 'k', value: 'on' }] });
    const c = client();
    await expect(c.variation('k', ctx, 'off', opt)).resolves.toBe('on');
    await c.close();
  });
});
