import { afterEach, describe, expect, it } from 'vitest';
import {
  FLAG_ALL_PATH,
  FLAG_EVALUATE_PATH,
  ORIGIN,
  client,
  nock,
  setupNock,
  testLogger,
} from './helpers';

setupNock();

/**
 * The cross-SDK flag surface, per `intempt-swift/docs/SDK-API-CONTRACT.md`.
 *
 * The assertions that matter here are the failure ones. A flag SDK is judged on what it returns
 * when the service is unreachable, not on the happy path.
 */
describe('variation', () => {
  afterEach(() => nock.cleanAll());

  const ctx = { userId: 'u-1', profileId: 'p-1' };

  it('returns the served value and its reason', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, {
      key: 'checkout_v2',
      value: true,
      variationId: 11,
      valueType: 'boolean',
      reason: 'targeted',
    });

    const c = client();
    await expect(c.variation('checkout_v2', ctx, false)).resolves.toBe(true);
    await c.close();
  });

  it('returns the default when the served value is null', async () => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'checkout_v2', value: null, reason: 'not_targeted' });

    const c = client();
    await expect(c.variation('checkout_v2', ctx, 'fallback')).resolves.toBe('fallback');
    await c.close();
  });

  it('returns the default when the service is unreachable', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(500, {});

    const c = client();
    await expect(c.variation('checkout_v2', ctx, 'safe')).resolves.toBe('safe');
    await c.close();
  });

  it('returns the default when the key is unknown to the service', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(404, { message: 'Flag not found' });

    const c = client();
    await expect(c.variation('never_created', ctx, 'safe')).resolves.toBe('safe');
    await c.close();
  });

  it('returns the default for a key the service would reject, without sending it (S11)', async () => {
    // L2. The service declares `@Pattern("^[a-zA-Z0-9_-]*$") String key`. S11 (Beso 2026-11-18)
    // reversed the old throw: the read returns the default with FLAG_NOT_FOUND and one warning per
    // key. No nock interceptor is registered on purpose: `disableNetConnect` fails the test if one
    // of these reaches the wire.
    const logger = testLogger();
    const c = client({ logger });
    for (const bad of ['has.dot', 'has:colon', 'has space', 'has/slash']) {
      await expect(c.variation(bad, ctx, 'd')).resolves.toBe('d');
    }
    expect(logger.calls.warn.map((a) => String(a[0]))).toHaveLength(4);
    expect(String(logger.calls.warn[0]?.[0])).toContain('^[a-zA-Z0-9_-]+$');
    await c.close();
  });

  it('accepts the characters the pattern allows', async () => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'New_checkout-v2', value: 'yes' });

    const c = client();
    await expect(c.variation('New_checkout-v2', ctx, 'd')).resolves.toBe('yes');
    await c.close();
  });

  it('a call with no defaultValue resolves undefined instead of throwing (S11)', async () => {
    const c = client();
    // @ts-expect-error defaultValue is required - this is the point of the assertion
    await expect(c.variation('checkout_v2', ctx)).resolves.toBeUndefined();
    await c.close();
  });

  it('an empty key returns the default (S11)', async () => {
    const c = client();
    await expect(c.variation('  ', ctx, 'x')).resolves.toBe('x');
    await c.close();
  });
});

describe('typed helpers', () => {
  afterEach(() => nock.cleanAll());
  const ctx = { userId: 'u-1' };

  it('falls back rather than coercing a wrong-typed value', async () => {
    // `!!"false"` is true. A silent coercion here would be indistinguishable from a correct answer,
    // which is worse than returning the default the caller chose.
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'f', value: 'false', reason: 'targeted' });

    const c = client();
    await expect(c.boolVariation('f', ctx, false)).resolves.toBe(false);
    await c.close();
  });

  it('accepts a correctly typed value', async () => {
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH)
      .reply(200, { key: 'f', value: 42, reason: 'targeted' });

    const c = client();
    await expect(c.numberVariation('f', ctx, 0)).resolves.toBe(42);
    await c.close();
  });
});

/** `allFlags` reads `/flags/all` without keys: only the served flags, and no exposure (F32). */
describe('allFlags', () => {
  afterEach(() => nock.cleanAll());

  const ctx = { userId: 'u-1' };

  it('returns every served key as a key -> value map', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, {
        flags: [
          { key: 'pricing_cta', value: 'Get started', valueType: 'string' },
          { key: 'rate_limits', value: { perMinute: 60 }, valueType: 'json' },
        ],
      });

    const c = client();
    await expect(c.allFlags(ctx)).resolves.toEqual({
      pricing_cta: 'Get started',
      rate_limits: { perMinute: 60 },
    });
    await c.close();
  });

  it('omits keys entirely, so the server answers only the served flags', async () => {
    // `keys: []` would be the same answer on 358d07d, but an absent field is the documented
    // "everything served" form; an explicit null would be a different request.
    let sent: Record<string, unknown> = {};
    nock(ORIGIN)
      .post(FLAG_ALL_PATH, (b) => {
        sent = b as Record<string, unknown>;
        return true;
      })
      .reply(200, { flags: [] });

    const c = client();
    await c.allFlags(ctx);
    await c.close();

    expect(Object.keys(sent)).not.toContain('keys');
    expect(sent.device).toBe('all');
  });

  it('maps a flag with no value to null rather than dropping it', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, { flags: [{ key: 'held_back' }] });

    const c = client();
    await expect(c.allFlags(ctx)).resolves.toEqual({ held_back: null });
    await c.close();
  });

  it('skips an entry with no usable key, and a non-object entry, rather than keying on undefined', async () => {
    nock(ORIGIN)
      .post(FLAG_ALL_PATH)
      .reply(200, {
        flags: [{ value: 'orphan' }, { key: '', value: 'blank' }, 'junk', null],
      });

    const c = client();
    await expect(c.allFlags(ctx)).resolves.toEqual({});
    await c.close();
  });

  it('returns an empty map when the service is unreachable', async () => {
    nock(ORIGIN).post(FLAG_ALL_PATH).reply(500, {});

    const c = client();
    await expect(c.allFlags(ctx)).resolves.toEqual({});
    await c.close();
  });

  it('applies the same identity guard as variation, returning an empty map (S11)', async () => {
    const c = client();
    await expect(c.allFlags({})).resolves.toEqual({});
    await c.close();
  });
});

describe('waitForInitialization', () => {
  it('resolves immediately because evaluation is remote', async () => {
    const c = client();
    await expect(c.waitForInitialization(5000)).resolves.toBeUndefined();
    await c.close();
  });
});

/**
 * The request body, pinned field by field.
 *
 * Added after a mutation run scored flags.ts at 58.33 with ten survivors. Every test above asserts
 * what comes BACK; none asserted what goes OUT, so a mutant could empty the identification object,
 * drop the key, or change the device literal and every one of them still passed. What the
 * SDK sends is half of a wire contract, and it was the unasserted half.
 */
describe('the /flags/evaluate request body', () => {
  afterEach(() => nock.cleanAll());

  /** Captures the body nock received, so each assertion below names one field. */
  async function bodySentBy(
    call: (c: ReturnType<typeof client>) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {};
    nock(ORIGIN)
      .post(FLAG_EVALUATE_PATH, (b) => {
        sent = b as Record<string, unknown>;
        return true;
      })
      .reply(200, { key: 'k', value: null });

    const c = client();
    await call(c);
    await c.close();
    return sent;
  }

  it('sends both identifiers and the configured source', async () => {
    const body = await bodySentBy((c) =>
      c.variation('k', { userId: 'u-1', profileId: 'p-1' }, 'd'),
    );

    // Kills the ObjectLiteral mutants on the identification block: an emptied object still
    // produced a 200 and the same default, so nothing noticed.
    expect(body.identification).toEqual({
      userId: 'u-1',
      profileId: 'p-1',
      sourceId: expect.any(String),
    });
  });

  it('omits an identifier the caller did not supply rather than sending null', async () => {
    const body = await bodySentBy((c) => c.variation('k', { userId: 'u-1' }, 'd'));

    // Kills the OptionalChaining mutants: context?.profileId returning undefined must drop the
    // key, not send it as null, which the service reads as an explicit anonymous identity.
    expect(body.identification).toEqual({ userId: 'u-1', sourceId: expect.any(String) });
    expect(Object.keys(body.identification as object)).not.toContain('profileId');
  });

  // -- the identity the serving endpoint can actually resolve -------------------------------
  //
  // The flag routes answer 400 unless the Identification names a visitor: a non-blank userId, or a
  // sourceId with a non-blank profileId. S11 (Beso 2026-11-18) reversed the old TypeError: each
  // unresolvable shape returns the default with TARGETING_KEY_MISSING, sends nothing, and warns once
  // per key with the explanation. Both directions are asserted, because a guard that also rejected
  // a LEGAL context would be invisible from the refusal tests alone.

  async function refused(context: unknown) {
    const logger = testLogger();
    const c = client({ logger });
    const detail = await c.variationDetail('k', context as never, 'd');
    await c.close();
    return { detail, warning: String(logger.calls.warn[0]?.[0]) };
  }

  it('refuses a call with no context at all, and says what a usable one needs', async () => {
    const { detail, warning } = await refused(undefined);
    expect(detail).toEqual({
      value: 'd',
      reason: 'error',
      errorCode: 'TARGETING_KEY_MISSING',
    });
    expect(warning).toMatch(
      /context needs either userId, or profileId together with a sourceId configured on the client/,
    );
  });

  it('refuses an empty context, and does not mention accountId when none was passed', async () => {
    const { detail, warning } = await refused({});
    expect(detail.errorCode).toBe('TARGETING_KEY_MISSING');
    expect(warning).toMatch(/returning the default$/);
  });

  it('refuses a blank userId rather than sending whitespace as an identity', async () => {
    const { detail } = await refused({ userId: '   ' });
    expect(detail.errorCode).toBe('TARGETING_KEY_MISSING');
  });

  it('refuses accountId, which the serving endpoint never receives', async () => {
    const { detail, warning } = await refused({ accountId: 'acme' });
    expect(detail.errorCode).toBe('TARGETING_KEY_MISSING');
    expect(warning).toMatch(/accountId is not an identifier/);
  });

  it('accepts a userId alone', async () => {
    // The reverse check for the USER branch. A guard demanding a sourceId unconditionally would
    // break every caller who identifies by user, and no refusal test above could see it.
    const body = await bodySentBy((c) => c.variation('k', { userId: 'u-1' }, 'd'));

    expect(body.identification).toMatchObject({ userId: 'u-1' });
  });

  it('refuses a profileId when the client has no sourceId configured', async () => {
    // The PROFILE branch needs BOTH halves. Without a configured sourceId this context satisfies
    // neither branch, so the service would 400 and every read would silently default.
    const c = client({ sourceId: undefined });
    await expect(
      c.variationDetail('k', { profileId: 'p-1' }, 'd'),
    ).resolves.toMatchObject({
      errorCode: 'TARGETING_KEY_MISSING',
    });
    await c.close();
  });

  it('accepts a profileId when a sourceId is configured', async () => {
    // The reverse check for the PROFILE branch: the same context is legal once the client can
    // supply the other half of the pair.
    const body = await bodySentBy((c) => c.variation('k', { profileId: 'p-1' }, 'd'));

    expect(body.identification).toMatchObject({ profileId: 'p-1' });
  });

  it('asks for exactly the one key requested, as `key`', async () => {
    const body = await bodySentBy((c) =>
      c.variation('checkout_v2', { userId: 'u' }, 'd'),
    );

    // /flags/evaluate takes exactly one key (F32): several keys would mark flags the code never
    // reads as exposed. choose-api's `names` must not leak onto this route.
    expect(body.key).toBe('checkout_v2');
    expect(Object.keys(body)).not.toContain('names');
    expect(Object.keys(body)).not.toContain('keys');
  });

  it("sends the caller's sessionId, which the exposure records (F32, Beso 2026-11-26)", async () => {
    const body = await bodySentBy((c) =>
      c.variation('k', { userId: 'u', sessionId: 's-42' }, 'd'),
    );

    expect(body.sessionId).toBe('s-42');
  });

  it("sends device 'all'", async () => {
    const body = await bodySentBy((c) => c.variation('k', { userId: 'u' }, 'd'));

    // A mutated device value changes which flags the service considers eligible — silently, and
    // only in production.
    expect(body.device).toBe('all');
  });
});

describe('when the service cannot be reached', () => {
  afterEach(() => nock.cleanAll());

  it('warns through the configured logger and still returns the default', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(503, {});

    const logger = testLogger();
    const c = client({ logger });
    await expect(c.variation('k', { userId: 'u' }, 'fallback')).resolves.toBe('fallback');

    // Kills the StringLiteral mutant on the warning: the catch returning [] was asserted, the
    // fact that anything is logged at all was not, so a silenced SDK looked identical.
    expect(logger.calls.warn.length).toBeGreaterThan(0);
    expect(String(logger.calls.warn[0]?.[0])).toContain('flag evaluation failed');
    await c.close();
  });

  it('treats an answer with no value as no answer', async () => {
    nock(ORIGIN).post(FLAG_EVALUATE_PATH).reply(200, {});

    const c = client();
    await expect(c.variation('k', { userId: 'u' }, 7)).resolves.toBe(7);
    await c.close();
  });
});
