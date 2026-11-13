import { afterEach, describe, expect, it } from 'vitest';
import { CHOOSE_PATH, ORIGIN, client, nock, setupNock } from './helpers';

setupNock();

/**
 * INT-7456 (CONTRACT-R2 §S4, research Q13): evaluation is separated from exposure. A bulk read
 * asks the service not to record; a single read records unless the caller opts out. An absent
 * `exposure` field is today's recording behaviour, so a default read must not send the key at all.
 */
const ctx = { userId: 'u-1' };
const opt = { disableExposure: true };

async function bodySentBy(
  call: (c: ReturnType<typeof client>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  nock(ORIGIN)
    .post(CHOOSE_PATH, (b) => {
      sent = b as Record<string, unknown>;
      return true;
    })
    .reply(200, { choices: [{ name: 'k', body: true }] });

  const c = client();
  await call(c);
  await c.close();
  return sent;
}

describe('exposure on the choose request', () => {
  afterEach(() => nock.cleanAll());

  it('allFlags evaluates without recording an exposure', async () => {
    const body = await bodySentBy((c) => c.allFlags(ctx));
    expect(body.exposure).toBe(false);
  });

  it('a single read records as before: no exposure field at all', async () => {
    const body = await bodySentBy((c) => c.variation('k', ctx, false));
    expect('exposure' in body).toBe(false);
  });

  it('disableExposure: false is the same as omitting it', async () => {
    const body = await bodySentBy((c) =>
      c.variation('k', ctx, false, { disableExposure: false }),
    );
    expect('exposure' in body).toBe(false);
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
  ])('%s with disableExposure sends exposure: false', async (_name, call) => {
    const body = await bodySentBy(call);
    expect(body.exposure).toBe(false);
    expect(body.names).toEqual(['k']);
  });

  it('opting out of the exposure still returns the served value', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'k', body: 'on' }] });
    const c = client();
    await expect(c.variation('k', ctx, 'off', opt)).resolves.toBe('on');
    await c.close();
  });
});
