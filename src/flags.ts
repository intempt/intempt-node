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
 *  3. `variationDetail` carries a `reason`. Without it a caller cannot tell a deliberate off state
 *     from a request the service never answered - an objection that was, correctly, why no SDK
 *     exposed assignment until the serving contract could distinguish the two.
 *  4. Evaluation is REMOTE only. There is no local rule engine and no flag store to poll.
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
   */
  profileId?: string;
}

export interface FlagDetail<T> {
  value: T;
  /** The variant name the platform selected, absent when nothing was served. */
  variant?: string;
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

export class Flags {
  readonly #deps: FlagsDeps;

  constructor(deps: FlagsDeps) {
    this.#deps = deps;
  }

  async detail<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
  ): Promise<FlagDetail<T>> {
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('variation: key is required');
    }
    if (defaultValue === undefined) {
      // Required, not optional. A caller who omits it has no answer during an outage, and the
      // failure surfaces far from here as an undefined branch.
      throw new TypeError('variation: defaultValue is required');
    }

    const choices = await this.#chooseOrEmpty(context, [key]);
    const choice = choices.find((c) => c.name === key);
    if (!choice) {
      return { value: defaultValue, reason: UNANSWERED };
    }
    return {
      value: (choice.body ?? defaultValue) as T,
      variant: choice.group,
      reason: choice.reason ?? UNANSWERED,
    };
  }

  async value<T>(key: string, context: FlagContext, defaultValue: T): Promise<T> {
    const { value } = await this.detail<T>(key, context, defaultValue);
    return value;
  }

  async all(context: FlagContext): Promise<Record<string, unknown>> {
    const choices = await this.#chooseOrEmpty(context, undefined);
    const out: Record<string, unknown> = {};
    for (const choice of choices) {
      if (choice.name) out[choice.name] = choice.body;
    }
    return out;
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
  async #chooseOrEmpty(
    context: FlagContext,
    names: string[] | undefined,
  ): Promise<RawChoice[]> {
    try {
      return await this.#choose(context, names);
    } catch (error) {
      this.#deps
        .config()
        .logger.warn('[intempt] flag evaluation failed, using defaults', error);
      return [];
    }
  }

  async #choose(context: FlagContext, names: string[] | undefined): Promise<RawChoice[]> {
    const { sourceId } = this.#deps.config();
    const body = compact({
      identification: compact({
        userId: context?.userId,
        profileId: context?.profileId,
        sourceId,
      }),
      names,
      device: 'all',
    });

    const response = await this.#deps.transport.post<{ choices?: RawChoice[] }>(
      this.#deps.transport.projectPath('/optimization/choose-api'),
      body,
    );
    return response.body?.choices ?? [];
  }
}
