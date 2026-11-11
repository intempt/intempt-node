import type { Identifiers, ResolvedConfig } from './types';
import { compact } from './utils';
import { IntemptApiError } from './transport';
import type { Transport } from './transport';

/**
 * Feature flags, experiments and personalizations, read by key.
 *
 * The cross-SDK surface is defined in `intempt-swift/docs/SDK-API-CONTRACT.md`, which every SDK
 * conforms to. Four of its rules shape this file:
 *
 *  1. The caller asks for a KEY, never a mode. The 1.x surface put the mode in the method name -
 *     `choosePersonalizationsByNames`, `chooseExperimentsByGroups` - which forced an integrator to
 *     know whether a key was an experiment before reading it, and grew combinatorially with every
 *     new mode. The platform resolves mode itself: its serving query filters on channel and status
 *     and never on mode.
 *  2. `defaultValue` is REQUIRED. It is what a caller receives on a network failure, a timeout, an
 *     unknown key or a malformed response. Optional is how `undefined` reaches production during an
 *     outage.
 *  3. `variationDetail` tells a failed read from an answered one (INT-7454, CONTRACT-R2 §S3):
 *     `reason: 'error'` plus a `FlagError` when the default was returned because the call failed.
 *     It cannot tell "off" from "not targeted", because the platform sends no reason, so every
 *     answered read reads `off` (INT-7457) rather than a guess.
 *  4. Evaluation is REMOTE only. There is no local rule engine and no flag store to poll.
 *  5. On a request path, every evaluation names the keys it wants. `POST /optimization/choose-api`
 *     records a Kafka exposure for each experience it evaluates, and it evaluates EVERY eligible
 *     experience when `names` is omitted -- so an unbounded read marks a person exposed to every
 *     running server experiment in the project, and (for a `once` display) permanently consumes
 *     their display budget for experiences nobody rendered. Requesting keys the caller actually
 *     reads is what keeps an evaluation and an exposure the same event.
 *
 *     `allFlags` is the one call that omits `names`, and it is documented as a hazard rather than
 *     withheld -- by ruling (Beso, 2026-09-01), because php, python, swift, java and reactnative
 *     all ship it and a surface present in five SDKs and absent from the sixth is its own defect.
 *     It is for enumerating, not for serving. See `#request` for the platform change that would
 *     make it safe.
 *
 * A server SDK is an `api`-channel consumer: it receives a value and branches on it in code. The
 * `web` channel, where a change is applied against the DOM without the caller branching, is
 * `intemptjs` alone.
 */

/**
 * Why an evaluation returned the value it did. Mirrors the platform's `ChoiceReason`, plus
 * `error`. Only `off` and `error` are produced today: the serving response carries no reason.
 */
export type FlagReason = 'targeted' | 'holdout' | 'not_targeted' | 'off' | 'error';

/** The same kinds in every SDK (CONTRACT-R2 §S3). */
export type FlagErrorKind =
  'auth' | 'bad_request' | 'server' | 'timeout' | 'network' | 'parse';

/** A flag read that failed; the caller's default was returned. `key` is null for `allFlags`. */
export interface FlagError {
  key: string | null;
  kind: FlagErrorKind;
  status?: number;
}

/** Who is being evaluated. One stable identifier the caller holds constant. */
export interface FlagContext extends Identifiers {
  /**
   * The anonymous/device identifier, when the caller has one. Supplying the same value before and
   * after a person signs in is what keeps their assignment stable across the transition.
   *
   * **When supplied, this is the identifier the platform buckets on and `userId` is ignored.**
   * `ExperienceChooserService.buildAudienceRequest` resolves a PROFILE entity keyed on `profileId`
   * whenever it is non-blank, and only falls through to a USER entity keyed on `userId` when it is
   * not. So this is a precedence, not a hint: pass both and assignment is device-scoped, and the
   * day the caller stops passing it every person re-buckets in one deploy. Pass ONE identifier and
   * hold it constant.
   */
  profileId?: string;

  /**
   * The caller's session identifier.
   *
   * **Required for `once_per_visit` experiences to behave per-session.** The platform stores the
   * session a variant was displayed in and re-serves only when a later call carries a different
   * one; with no `sessionId` it stores the literal `"default"`, which never differs from itself, so
   * `once_per_visit` collapses to "once, then never" and every Kafka exposure is stamped
   * `"default"`. A server SDK may genuinely have no session concept -- in that case leave it unset
   * and know that `once_per_visit` degrades to `once` on this channel, rather than inheriting it.
   */
  sessionId?: string;
}

export interface FlagDetail<T> {
  value: T;
  reason: FlagReason;
  /** Present only when `reason` is `error`. */
  error?: FlagError;
}

interface RawChoice {
  name?: string;
  group?: string;
  body?: unknown;
}

export interface FlagsDeps {
  transport: Transport;
  config(): ResolvedConfig;
  /** Named in the 401/403 log; the secret half never reaches this class. */
  keyPrefix: string;
}

/**
 * 408 is the gateway's timeout and 429 the service's capacity, so neither is the caller's
 * malformed request -- the same mapping as php and python.
 */
function classify(key: string | null, error: unknown): FlagError {
  const status = error instanceof IntemptApiError ? error.status : undefined;
  if (status === undefined) {
    const timedOut = error instanceof IntemptApiError && error.timedOut;
    return { key, kind: timedOut ? 'timeout' : 'network' };
  }
  if (status === 401 || status === 403) return { key, kind: 'auth', status };
  if (status === 408) return { key, kind: 'timeout', status };
  if (status === 429 || status >= 500) return { key, kind: 'server', status };
  return { key, kind: 'bad_request', status };
}

/** A response the service did not answer is reported as such rather than guessed at. */
const UNANSWERED: FlagReason = 'off';

/**
 * The platform's own key pattern, from `ExperienceApiChooseRequest`:
 * `Set<@Pattern(regexp = "^[a-zA-Z0-9_-]*$") String> names`. Tightened to `+` here because a blank
 * key is already rejected above.
 */
const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

export class Flags {
  readonly #deps: FlagsDeps;
  #authLogged = false;

  constructor(deps: FlagsDeps) {
    this.#deps = deps;
  }

  /**
   * `reason` is `error` only when the call failed. An answered read is `off` whether or not a value
   * was served: a held-back person's experience is absent from the response rather than present
   * with a cause, so telling "off" from "not targeted" would be a guess (INT-7457).
   */
  async detail<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
  ): Promise<FlagDetail<T>> {
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('variation: key is required');
    }
    if (!KEY_PATTERN.test(key)) {
      // A key the service will reject is a programming error, and it must fail here rather than
      // 400 downstream: `#choose` absorbs a validation error into a warn and the caller's
      // default, which makes a typo'd key indistinguishable from an outage.
      throw new TypeError(
        `variation: key must match ${KEY_PATTERN.source} (the platform's own pattern); got "${key}"`,
      );
    }
    if (defaultValue === undefined) {
      // Required, not optional. A caller who omits it has no answer during an outage, and the
      // failure surfaces far from here as an undefined branch.
      throw new TypeError('variation: defaultValue is required');
    }
    this.#assertAnswerable(context);

    const { choices, error } = await this.#choose(context, [key], key);
    if (error) {
      return { value: defaultValue, reason: 'error', error };
    }
    const choice = choices.find((c) => c.name === key);
    if (!choice) {
      return { value: defaultValue, reason: UNANSWERED };
    }
    return {
      value: (choice.body ?? defaultValue) as T,
      // Not read off the wire (INT-7457): ExperienceApiChoose carries only name/group/body, so a
      // `reason` key could only come from a fixture. RawChoice has no `reason`, so tsc refuses a
      // reintroduced read.
      reason: UNANSWERED,
    };
  }

  async value<T>(key: string, context: FlagContext, defaultValue: T): Promise<T> {
    const { value } = await this.detail<T>(key, context, defaultValue);
    return value;
  }

  /**
   * Every key assigned to this person, in one call, as a name -> value map.
   *
   * ⚠ **This is not a free convenience, and it does not belong on a request path.** It sends no
   * `names`, so the service evaluates every api-channel experience the person is eligible for, and
   * on this endpoint an evaluation IS an exposure — see `#request` for the full trace. Two costs,
   * both silent:
   *
   *  - the denominator of every running server experiment fills with people who were never shown
   *    anything, uniformly across arms, so it reads as an experiment that stopped detecting; and
   *  - a `once` / `once_per_visit` experience is marked displayed for keys nobody rendered, after
   *    which `variation()` on those keys returns the caller's default forever, indistinguishably
   *    from an outage.
   *
   * Use it to enumerate — a debug endpoint, an admin view, a one-off audit. **Two keys on a request
   * path means two `variation()` calls, not one `allFlags()`.** The request carries no
   * exposure-suppression field, so no SDK can make this safe; that needs an `exposure: false` on
   * `POST /optimization/choose-api` or a separate non-recording route.
   *
   * Matches `allFlags` in php, swift, java and reactnative and `all_flags` in python.
   */
  async all(context: FlagContext): Promise<Record<string, unknown>> {
    this.#assertAnswerable(context);

    const out: Record<string, unknown> = {};
    const { choices } = await this.#choose(context, undefined, null);
    for (const choice of choices) {
      if (typeof choice.name === 'string' && choice.name !== '') {
        out[choice.name] = choice.body ?? null;
      }
    }
    return out;
  }

  /**
   * A context the service cannot resolve is a caller mistake, so it throws here.
   *
   * `ExperienceChooserService.buildAudienceRequest` resolves a PROFILE entity from a non-blank
   * `profileId` plus a configured `sourceId`, falls through to a USER entity from `userId`, and
   * throws when neither matches. `#choose` absorbs a service failure by design -- so without
   * this check an unresolvable context returns the caller's default for every key, forever, behind
   * one warn line, and the integration looks healthy while nothing is ever personalized.
   *
   * Deliberately NOT absorbed the way a transport failure is. A 5xx is a runtime condition that
   * must resolve to the default; an unanswerable identity is a programming error that never
   * recovers. This is the same rule the key-pattern check above already applies.
   *
   * `accountId` is the trap worth naming: `FlagContext extends Identifiers`, so TypeScript accepts
   * it, and `#request` sends only `userId`/`profileId`/`sourceId` -- an account-only caller was
   * type-checked, silently dropped, and served defaults forever.
   */
  #assertAnswerable(context: FlagContext): void {
    const present = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
    const { sourceId } = this.#deps.config();

    if (present(context?.userId)) return;
    if (present(context?.profileId) && present(sourceId)) return;

    const hadAccountOnly = present(
      (context as { accountId?: string } | undefined)?.accountId,
    );
    throw new TypeError(
      'variation: context needs either userId, or profileId together with a sourceId configured ' +
        'on the client — the serving endpoint resolves an entity by one or the other and rejects ' +
        'anything else' +
        (hadAccountOnly
          ? '. accountId is not an identifier the serving endpoint accepts; it is dropped from the request'
          : ''),
    );
  }

  /**
   * A transport failure returns no choices and a `FlagError` rather than throwing.
   *
   * This is the entire reason `defaultValue` is required: a network failure, a 5xx or a timeout
   * must resolve to the value the caller chose, not reject. A flag SDK that throws when the service
   * is unreachable takes the application down with it - which is the opposite of what a kill switch
   * is for. A validation mistake (missing key, missing default) still throws, because that is a
   * programming error the caller can fix and not a runtime condition to absorb.
   */
  async #choose(
    context: FlagContext,
    names: string[] | undefined,
    key: string | null,
  ): Promise<{ choices: RawChoice[]; error?: FlagError }> {
    let body: unknown;
    try {
      body = (await this.#request(context, names)).body;
    } catch (error) {
      return { choices: [], error: this.#failed(classify(key, error), error) };
    }
    // The transport hands back a non-JSON body as its raw string and an empty one as undefined.
    // A missing `choices` stays an honest "nothing served", as it always was.
    const choices =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? ((body as { choices?: unknown }).choices ?? [])
        : undefined;
    if (!Array.isArray(choices)) {
      return { choices: [], error: this.#failed({ key, kind: 'parse' }, body) };
    }
    return { choices: choices as RawChoice[] };
  }

  /**
   * A 401/403 is a misconfigured key that every later read repeats, so it is loud once per client
   * and quiet after, instead of one warn per request that operators learn to filter.
   */
  #failed(error: FlagError, cause: unknown): FlagError {
    const { logger, sourceId, onFlagError } = this.#deps.config();
    if (error.kind === 'auth' && !this.#authLogged) {
      this.#authLogged = true;
      logger.error(
        `[intempt] flag evaluation refused with ${error.status}: check the API key ` +
          `(prefix ${this.#deps.keyPrefix}) and sourceId ${sourceId ?? '(none)'}; serving defaults`,
      );
    } else if (error.kind === 'auth') {
      logger.debug(
        `[intempt] flag evaluation refused with ${error.status}; using defaults`,
      );
    } else {
      logger.warn(
        `[intempt] flag evaluation failed (${error.kind}), using defaults`,
        cause,
      );
    }
    if (onFlagError) {
      try {
        onFlagError(error);
      } catch (thrown) {
        logger.error('[intempt] onFlagError listener threw', thrown);
      }
    }
    return error;
  }

  /**
   * `names` is omitted ONLY by `allFlags`, and that is not a free convenience.
   *
   * Omitting it is not "ask for everything" -- it is "evaluate everything", and on this endpoint an
   * evaluation IS an exposure. `ExperienceChooserService.chooseApi` passes a null `names` straight
   * into `retrieveApiExperiences`, which returns every api-channel experience the person is
   * eligible for; each one flows through `VariantChooserService.chooseVariants` -> `choose` ->
   * `publishAndParse` -> `ChooserHelper.publishEvent` -> `kafkaPublisher.publishExperienceChoose`
   * on EVERY call, not only on first assignment. Two things break at once:
   *
   *  - every running server experiment's denominator fills with people who never saw the variant,
   *    uniformly across arms, so it reads as an experiment that stopped detecting rather than as a
   *    broken one; and
   *  - `ChooserHelper.display` calls `saveSession` for each variant, so a `once` experience is
   *    marked displayed for keys nobody rendered, `allowOnce` is false from then on, the experience
   *    drops out of `choices` forever, and the caller gets their default indistinguishably from an
   *    outage.
   *
   * The request carries no exposure-suppression field -- `ExperienceApiChooseRequest` is
   * `{identification, names, groups, device, sessionId, productId, timestamp}` -- so the SDK cannot
   * opt out of recording, only decline to evaluate what nobody asked for. **A read-everything call
   * becomes safe when the platform can evaluate without publishing** (an `exposure: false` on this
   * request, or a separate non-recording route).
   *
   * `allFlags` is kept anyway, by ruling (Beso, 2026-09-01), because php, python, swift, java and
   * reactnative all ship it and a surface that exists in five SDKs and not the sixth is its own
   * kind of defect. It is documented as a hazard rather than removed. Prefer `variation` per key on
   * anything that runs per request.
   */
  async #request(
    context: FlagContext,
    names: string[] | undefined,
  ): Promise<{ body: unknown }> {
    const { sourceId } = this.#deps.config();
    const body = compact({
      // No optional chaining on `context`: `#assertAnswerable` has already rejected an absent or
      // unresolvable one, so a `context?.` here would be a branch no test could ever take -- an
      // unkillable mutant paid for out of the mutation budget.
      identification: compact({
        userId: context.userId,
        profileId: context.profileId,
        sourceId,
      }),
      names,
      device: 'all',
      sessionId: context.sessionId,
    });

    return this.#deps.transport.post(
      this.#deps.transport.projectPath('/optimization/choose-api'),
      body,
    );
  }
}
