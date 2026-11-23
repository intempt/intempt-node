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
 * F6: the detail carries the server's answer fields (`FlagValue` at audience-service 358d07d:
 * key, value, variationId, valueType, reason). The reason is passed through, never mapped by the
 * SDK; a field an older server leaves out is simply absent and the reason falls back to `off`.
 */
const ctx = { userId: 'u-1' };

describe('variationDetail reads the answer fields', () => {
  afterEach(() => nock.cleanAll());

  it('a served flag carries value, reason, variationId and valueType', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, {
      key: 'new_checkout',
      value: true,
      variationId: 31,
      valueType: 'boolean',
      reason: 'targeted',
    });
    const c = client();
    await expect(c.variationDetail('new_checkout', ctx, false)).resolves.toEqual({
      value: true,
      reason: 'targeted',
      variationId: 31,
      valueType: 'boolean',
    });
    await c.close();
  });

  it.each(['not_targeted', 'not_in_rollout', 'off', 'killed', 'not_client_side'])(
    'an unserved flag returns the default with the server reason %s',
    async (reason) => {
      nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, {
        key: 'k',
        value: null,
        variationId: null,
        valueType: 'boolean',
        reason,
      });
      const c = client();
      await expect(c.variationDetail('k', ctx, false)).resolves.toEqual({
        value: false,
        reason,
        valueType: 'boolean',
      });
      await c.close();
    },
  );

  it('a reason this SDK has never seen is passed through, not mapped', async () => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'k', value: 'x', reason: 'some_future_reason' });
    const c = client();
    const detail = await c.variationDetail('k', ctx, 'd');
    expect(detail.reason).toBe('some_future_reason');
    await c.close();
  });

  it("an older server's answer without the fields reads 'off' and never fails", async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, { key: 'k', value: 'x' });
    const c = client();
    await expect(c.variationDetail('k', ctx, 'd')).resolves.toEqual({
      value: 'x',
      reason: 'off',
    });
    await c.close();
  });

  it('fields of the wrong type are dropped, not trusted', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, {
      key: 'k',
      value: 'x',
      reason: 7,
      variationId: '31',
      valueType: false,
    });
    const c = client();
    await expect(c.variationDetail('k', ctx, 'd')).resolves.toEqual({
      value: 'x',
      reason: 'off',
    });
    await c.close();
  });

  it('a disableExposure read carries the same fields from /flags/all', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, {
        flags: [
          {
            key: 'k',
            value: 'b',
            variationId: 5,
            valueType: 'string',
            reason: 'targeted',
          },
        ],
      });
    const c = client();
    await expect(
      c.variationDetail('k', ctx, 'a', { disableExposure: true }),
    ).resolves.toEqual({
      value: 'b',
      reason: 'targeted',
      variationId: 5,
      valueType: 'string',
    });
    await c.close();
  });
});
