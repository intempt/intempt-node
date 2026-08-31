import type { Identifiers, ResolvedConfig } from './types';
import { compact } from './utils';
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
 *  3. `variationDetail` is NOT exposed. It would carry a `reason`, and the platform does not send
 *     one -- so it could not tell a deliberate off state from a request the service never
 *     answered, which is the only thing it exists to do. It returns when the serving contract
 *     carries a reason.
 *  4. Evaluation is REMOTE only. There is no local rule engine and no flag store to poll.
 *  5. Every evaluation names the keys it wants. There is no "read everything" call. `POST
 *     /optimization/choose-api` records a Kafka exposure for each experience it evaluates, and it
 *     evaluates EVERY eligible experience when `names` is omitted -- so an unbounded read marks a
 *     person exposed to every running server experiment in the project, and (for a `once` display)
 *     permanently consumes their display budget for experiences nobody rendered. Requesting keys
 *     the caller actually reads is what keeps an evaluation and an exposure the same event. See
 *     `#choose` for the platform change that would let a read-everything call return.
 *
 * A server SDK is an `api`-channel consumer: it receives a value and branches on it in code. The
 * `web` channel, where a change is applied against the DOM without the caller branching, is
 * `intemptjs` alone.
 */

/** Why an evaluation returned the value it did. Mirrors the platform's `ChoiceReason`. */
export type FlagReason = 'targeted' | 'holdout' | 'not_targeted' | 'off';

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

/** Internal only -- see the note on `#detail`. Not exported from the package. */
interface FlagDetail<T> {
  value: T;
  reason: FlagReason;
}

interface RawChoice {
  name?: string;
  group?: string;
  body?: unknown;
  reason?: FlagReason;
}

export interface FlagsDeps {
  transport: Transport;
  config(): ResolvedConfig;
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

  constructor(deps: FlagsDeps) {
    this.#deps = deps;
  }

  /**
   * Internal. NOT public, deliberately.
   *
   * It returns a `reason`, and the platform does not send one: a held-back person's experience is
   * absent from the evaluation response entirely rather than present with a cause. So every reason
   * would read `off` -- including for someone who WAS targeted and did receive the variant. That is
   * a wrong answer, not a missing one, and a method whose only job is explaining why must not guess.
   *
   * `value` uses it for the value, which is correct either way. It becomes public when the serving
   * contract carries a reason.
   */
  async #detail<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
  ): Promise<FlagDetail<T>> {
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('variation: key is required');
    }
    if (!KEY_PATTERN.test(key)) {
      // A key the service will reject is a programming error, and it must fail here rather than
      // 400 downstream: `#chooseOrEmpty` absorbs a validation error into a warn and the caller's
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

    const choices = await this.#chooseOrEmpty(context, [key]);
    const choice = choices.find((c) => c.name === key);
    if (!choice) {
      return { value: defaultValue, reason: UNANSWERED };
    }
    return {
      value: (choice.body ?? defaultValue) as T,
      reason: choice.reason ?? UNANSWERED,
    };
  }

  async value<T>(key: string, context: FlagContext, defaultValue: T): Promise<T> {
    const { value } = await this.#detail<T>(key, context, defaultValue);
    return value;
  }

  /**
   * A context the service cannot resolve is a caller mistake, so it throws here.
   *
   * `ExperienceChooserService.buildAudienceRequest` resolves a PROFILE entity from a non-blank
   * `profileId` plus a configured `sourceId`, falls through to a USER entity from `userId`, and
   * throws when neither matches. `#chooseOrEmpty` absorbs a service failure by design -- so without
   * this check an unresolvable context returns the caller's default for every key, forever, behind
   * one warn line, and the integration looks healthy while nothing is ever personalized.
   *
   * Deliberately NOT absorbed the way a transport failure is. A 5xx is a runtime condition that
   * must resolve to the default; an unanswerable identity is a programming error that never
   * recovers. This is the same rule the key-pattern check above already applies.
   *
   * `accountId` is the trap worth naming: `FlagContext extends Identifiers`, so TypeScript accepts
   * it, and `#choose` sends only `userId`/`profileId`/`sourceId` -- an account-only caller was
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
   * A transport failure returns no choices rather than throwing.
   *
   * This is the entire reason `defaultValue` is required: a network failure, a 5xx or a timeout
   * must resolve to the value the caller chose, not reject. A flag SDK that throws when the service
   * is unreachable takes the application down with it - which is the opposite of what a kill switch
   * is for. A validation mistake (missing key, missing default) still throws, because that is a
   * programming error the caller can fix and not a runtime condition to absorb.
   */
  async #chooseOrEmpty(context: FlagContext, names: string[]): Promise<RawChoice[]> {
    try {
      return await this.#choose(context, names);
    } catch (error) {
      this.#deps
        .config()
        .logger.warn('[intempt] flag evaluation failed, using defaults', error);
      return [];
    }
  }

  /**
   * `names` is REQUIRED and is never omitted.
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
   * becomes possible when the platform can evaluate without publishing** (an `exposure: false` on
   * this request, or a separate non-recording route). Until then, every read names its keys.
   */
  async #choose(context: FlagContext, names: string[]): Promise<RawChoice[]> {
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

    const response = await this.#deps.transport.post<{ choices?: RawChoice[] }>(
      this.#deps.transport.projectPath('/optimization/choose-api'),
      body,
    );
    return response.body?.choices ?? [];
  }
}
