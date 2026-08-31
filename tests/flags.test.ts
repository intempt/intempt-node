import { afterEach, describe, expect, it } from 'vitest';
import { CHOOSE_PATH, ORIGIN, client, nock, setupNock, testLogger } from './helpers';

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
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, {
        choices: [{ name: 'checkout_v2', group: 'B', body: true, reason: 'targeted' }],
      });

    // `variation`, not `variationDetail` -- the detail method is internal until the platform sends
    // a reason. `group` IS on the wire (`ExperienceApiChoose` declares name, group, body); `reason`
    // is not, on any merged branch. So asserting on the reason here would prove nothing, and the
    // mock carries it only to show that an unknown field is ignored rather than trusted.
    const c = client();
    await expect(c.variation('checkout_v2', ctx, false)).resolves.toBe(true);
    await c.close();
  });

  it('returns the default when the served body is null', async () => {
    // NOT the holdout case, which cannot be asserted: a held-back person's experience is absent
    // from the response entirely rather than present with a cause. Telling a holdout from an
    // outage needs a reason the platform does not send, so neither is claimed here.
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'checkout_v2', body: null }] });

    const c = client();
    await expect(c.variation('checkout_v2', ctx, 'fallback')).resolves.toBe('fallback');
    await c.close();
  });

  it('returns the default when the service is unreachable', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(500, {});

    const c = client();
    await expect(c.variation('checkout_v2', ctx, 'safe')).resolves.toBe('safe');
    await c.close();
  });

  it('returns the default when the key is unknown to the service', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, { choices: [] });

    const c = client();
    await expect(c.variation('never_created', ctx, 'safe')).resolves.toBe('safe');
    await c.close();
  });

  it('throws on a key the service would reject rather than returning the default', async () => {
    // L2. The service declares `Set<@Pattern("^[a-zA-Z0-9_-]*$") String> names`, so a key with a
    // dot, colon or space comes back a validation error — which `#chooseOrEmpty` absorbs into a
    // warn and the caller's default, making a typo indistinguishable from an outage. No nock
    // interceptor is registered here on purpose: if the SDK let one of these reach the wire,
    // `disableNetConnect` would fail the test rather than let it pass quietly.
    const c = client();
    for (const bad of ['has.dot', 'has:colon', 'has space', 'has/slash']) {
      await expect(c.variation(bad, ctx, 'd')).rejects.toThrow(TypeError);
      await expect(c.variation(bad, ctx, 'd')).rejects.toThrow(/\^\[a-zA-Z0-9_-\]\+\$/);
    }
    await c.close();
  });

  it('accepts the characters the pattern allows', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'New_checkout-v2', body: 'yes' }] });

    const c = client();
    await expect(c.variation('New_checkout-v2', ctx, 'd')).resolves.toBe('yes');
    await c.close();
  });

  it('refuses a call with no defaultValue', async () => {
    const c = client();
    // @ts-expect-error defaultValue is required - this is the point of the assertion
    await expect(c.variation('checkout_v2', ctx)).rejects.toThrow(
      /defaultValue is required/,
    );
    await c.close();
  });

  it('refuses an empty key', async () => {
    const c = client();
    await expect(c.variation('  ', ctx, 'x')).rejects.toThrow(/key is required/);
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
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'f', body: 'false', reason: 'targeted' }] });

    const c = client();
    await expect(c.boolVariation('f', ctx, false)).resolves.toBe(false);
    await c.close();
  });

  it('accepts a correctly typed value', async () => {
    nock(ORIGIN)
      .post(CHOOSE_PATH)
      .reply(200, { choices: [{ name: 'f', body: 42, reason: 'targeted' }] });

    const c = client();
    await expect(c.numberVariation('f', ctx, 0)).resolves.toBe(42);
    await c.close();
  });
});

/**
 * There is no read-everything call, and this is the test that keeps it that way.
 *
 * `POST /optimization/choose-api` publishes a Kafka exposure per experience it evaluates, and it
 * evaluates EVERY eligible experience when `names` is omitted. So a convenience `allFlags()` marks
 * the person exposed to every running server experiment (inflating every denominator uniformly,
 * which reads as an experiment that stopped detecting rather than a broken one) and spends the
 * `once` display budget for keys nobody rendered, after which `variation()` on those keys returns
 * the caller's default forever. The request carries no exposure-suppression field, so the only
 * lever the SDK has is declining to evaluate what nobody asked for.
 */
describe('there is no unbounded read', () => {
  afterEach(() => nock.cleanAll());

  it('does not expose allFlags', () => {
    const c = client();
    expect((c as unknown as Record<string, unknown>).allFlags).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(c))).not.toContain(
      'allFlags',
    );
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
 * drop the names array, or change the device literal and every one of them still passed. What the
 * SDK sends is half of a wire contract, and it was the unasserted half.
 */
describe('the choose request body', () => {
  afterEach(() => nock.cleanAll());

  /** Captures the body nock received, so each assertion below names one field. */
  async function bodySentBy(
    call: (c: ReturnType<typeof client>) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {};
    nock(ORIGIN)
      .post(CHOOSE_PATH, (b) => {
        sent = b as Record<string, unknown>;
        return true;
      })
      .reply(200, { choices: [] });

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

  it('refuses a call with no context at all, rather than defaulting forever', async () => {
    // This used to assert the opposite -- that the call "survives" and sends
    // `identification: {sourceId}` alone. That shape is one the serving endpoint cannot resolve:
    // `buildAudienceRequest` matches neither its PROFILE nor its USER branch and throws, and
    // `#chooseOrEmpty` absorbs a service failure by design, so the caller received their default
    // for every key, forever, behind one warn line. The old test was locking in the bug.
    const c = client();

    // The message matters, not just the type. `Cannot read properties of undefined` is ALSO a
    // TypeError, so asserting the class alone would let the optional chaining in
    // `#assertAnswerable` be deleted -- the guard would still "throw", for entirely the wrong
    // reason, and a caller would get a stack trace instead of an explanation. Stryker survived
    // exactly that mutant until this assertion named the text.
    await expect(
      c.variation('k', undefined as unknown as { userId: string }, 'd'),
    ).rejects.toThrow(/context needs either userId/);
    await c.close();
  });

  // -- the identity the serving endpoint can actually resolve -------------------------------
  //
  // `buildAudienceRequest` resolves a PROFILE entity from a non-blank profileId plus a configured
  // sourceId, falls through to a USER entity from userId, and throws when neither matches. Since
  // `#chooseOrEmpty` absorbs a service failure by design, an unresolvable context used to come back
  // as the caller's default -- for every key, forever, behind one warn line.
  //
  // Measured on this branch before the guard existed: all four shapes below returned "THE-DEFAULT"
  // and threw nothing. Both directions are asserted, because a guard that also rejected a LEGAL
  // context would be invisible from the refusal tests alone.

  it('refuses an empty context, and says what a usable one needs', async () => {
    // The whole message is asserted, not just that something threw. This error is the only thing
    // a caller sees at the moment they are stuck, so its text is behaviour: it has to name both
    // acceptable shapes and say why the service rejects anything else. Asserting only /userId/
    // left three string mutants alive that blanked the explanation and kept the test green.
    const c = client();
    await expect(c.variation('k', {}, 'd')).rejects.toThrow(
      /context needs either userId, or profileId together with a sourceId configured on the client/,
    );
    await expect(c.variation('k', {}, 'd')).rejects.toThrow(
      /resolves an entity by one or the other and rejects anything else/,
    );
    await c.close();
  });

  it('does not mention accountId when the caller never passed one', async () => {
    // The other half of the accountId branch. Without this, appending the accountId sentence
    // unconditionally would pass every other test -- the message would simply be wrong for the
    // common case, telling a caller about a field they never used.
    const c = client();
    await expect(c.variation('k', {}, 'd')).rejects.toThrow(/rejects anything else$/);
    await c.close();
  });

  it('refuses a blank userId rather than sending whitespace as an identity', async () => {
    // Truthiness is not identity: '   ' is truthy and the service tests isBlank().
    const c = client();
    await expect(c.variation('k', { userId: '   ' }, 'd')).rejects.toThrow(TypeError);
    await c.close();
  });

  it('refuses accountId, which the serving endpoint never receives', async () => {
    // `FlagContext extends Identifiers`, so accountId type-checks -- and `#choose` sends only
    // userId/profileId/sourceId, so it was dropped in silence. The message says so explicitly.
    const c = client();
    await expect(c.variation('k', { accountId: 'acme' } as never, 'd')).rejects.toThrow(
      /accountId is not an identifier/,
    );
    await c.close();
  });

  it('accepts a userId alone', async () => {
    // The reverse check for the USER branch. A guard demanding a sourceId unconditionally would
    // break every caller who identifies by user, and no refusal test above could see it.
    const body = await bodySentBy((c) => c.variation('k', { userId: 'u-1' }, 'd'));

    expect(body.identification).toMatchObject({ userId: 'u-1' });
  });

  it('refuses a profileId when the client has no sourceId configured', async () => {
    // The PROFILE branch needs BOTH halves. Without a configured sourceId this context satisfies
    // neither branch, so the service throws and every read would silently default.
    //
    // This test exists because a planted mutation survived without it: dropping `&& present(
    // sourceId)` from the guard left all 410 other tests green, since every other case either
    // carries a userId or runs against a client that happens to configure a source.
    const c = client({ sourceId: undefined });

    await expect(c.variation('k', { profileId: 'p-1' }, 'd')).rejects.toThrow(/sourceId/);
    await c.close();
  });

  it('accepts a profileId when a sourceId is configured', async () => {
    // The reverse check for the PROFILE branch: the same context is legal once the client can
    // supply the other half of the pair.
    const body = await bodySentBy((c) => c.variation('k', { profileId: 'p-1' }, 'd'));

    expect(body.identification).toMatchObject({ profileId: 'p-1' });
  });

  it('asks for exactly the keys requested', async () => {
    const body = await bodySentBy((c) =>
      c.variation('checkout_v2', { userId: 'u' }, 'd'),
    );

    // Kills the ArrayDeclaration mutant: [key] emptied to [] asks the service for every flag,
    // which still answers, and the caller still gets its default.
    expect(body.names).toEqual(['checkout_v2']);
  });

  it('always names the keys it evaluates, and never omits names', async () => {
    // The C1/H1 guard on the wire itself. An omitted or emptied `names` makes the service
    // evaluate — and record an exposure against — every eligible experience, so the assertion is
    // that a bounded, non-empty list goes out on every evaluation. Kills a mutant that drops the
    // field or empties the array: the service answers either way and the caller still gets a
    // value, so nothing else in this suite would notice.
    const body = await bodySentBy((c) =>
      c.variation('checkout_v2', { userId: 'u' }, 'd'),
    );

    expect(body.names).toBeDefined();
    expect(Array.isArray(body.names)).toBe(true);
    expect((body.names as string[]).length).toBeGreaterThan(0);
  });

  it('sends sessionId when the caller supplies one', async () => {
    // H2: without it the platform stores the literal "default", so `once_per_visit` degrades to
    // "once, then never" and every exposure event is stamped "default".
    const body = await bodySentBy((c) =>
      c.variation('k', { userId: 'u', sessionId: 's-42' }, 'd'),
    );

    expect(body.sessionId).toBe('s-42');
  });

  it('omits sessionId rather than sending null when the caller has none', async () => {
    const body = await bodySentBy((c) => c.variation('k', { userId: 'u' }, 'd'));

    expect(Object.keys(body)).not.toContain('sessionId');
  });

  it("sends device 'all'", async () => {
    const body = await bodySentBy((c) => c.variation('k', { userId: 'u' }, 'd'));

    // Kills the StringLiteral mutant on line 142. A mutated device value changes which
    // experiences the service considers eligible — silently, and only in production.
    expect(body.device).toBe('all');
  });
});

describe('when the service cannot be reached', () => {
  afterEach(() => nock.cleanAll());

  it('warns through the configured logger and still returns the default', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(503, {});

    const logger = testLogger();
    const c = client({ logger });
    await expect(c.variation('k', { userId: 'u' }, 'fallback')).resolves.toBe('fallback');

    // Kills the StringLiteral mutant on the warning: the catch returning [] was asserted, the
    // fact that anything is logged at all was not, so a silenced SDK looked identical.
    expect(logger.calls.warn.length).toBeGreaterThan(0);
    expect(String(logger.calls.warn[0]?.[0])).toContain('flag evaluation failed');
    await c.close();
  });

  it('treats a response with no choices array as no answer', async () => {
    nock(ORIGIN).post(CHOOSE_PATH).reply(200, {});

    // Kills the OptionalChaining mutant on line 149: response.body?.choices ?? [].
    const c = client();
    await expect(c.variation('k', { userId: 'u' }, 7)).resolves.toBe(7);
    await c.close();
  });
});
