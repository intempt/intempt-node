import type { ResolvedConfig } from './types';
import { compact } from './utils';
import { IntemptApiError } from './transport';
import type { Transport } from './transport';

/** Who is being served. Not `FlagContext`: choose-api also needs `sessionId` for `once_per_visit`. */
export interface ChooseContext {
  userId?: string;
  /** Paired with the client's `sourceId`. When both ids are sent the server decides which one buckets. */
  profileId?: string;
  sessionId?: string;
}

/**
 * Omitting both `names` and `groups` is allowed and evaluates, and so EXPOSES, every API-channel
 * experience the person is eligible for. See `Choose.#request`.
 */
export interface ChooseOptions {
  names?: string[];
  groups?: string[];
  /** Evaluate without recording an exposure or spending a `once` gate. Sent as `exposure: false`. */
  disableExposure?: boolean;
}

/**
 * One served experience or personalization. Production choose-api returns only `name`, `group` and
 * `body`; `experienceId`, `variantId` and `reason` are present only on audience-service builds that
 * send them.
 */
export interface Choice {
  name: string;
  group?: string;
  body: unknown;
  experienceId?: number;
  variantId?: number;
  reason?: string;
}

export interface ChooseDeps {
  transport: Transport;
  config: () => ResolvedConfig;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const present = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Experiments and personalizations over `POST /optimization/choose-api`. Internal; reached only
 * through `IntemptClient.choose`. Imports nothing from the flag evaluator, so the `./flags` entry
 * stays free of it.
 *
 * Every runtime failure resolves `[]` after one log line: a caller renders its fallback, which is
 * what an unserved experiment looks like anyway. Only a malformed call rejects.
 */
export class Choose {
  readonly #deps: ChooseDeps;

  constructor(deps: ChooseDeps) {
    this.#deps = deps;
  }

  async choose(context: ChooseContext, options: ChooseOptions = {}): Promise<Choice[]> {
    this.#validate(context, options);
    const { logger } = this.#deps.config();

    let reply: unknown;
    try {
      reply = (await this.#request(context, options)).body;
    } catch (error) {
      const status = error instanceof IntemptApiError ? error.status : undefined;
      const message = `[intempt] choose: request failed, returning no choices (${
        error instanceof Error ? error.message : String(error)
      })`;
      if (status === 401 || status === 403) logger.error(message);
      else logger.warn(message);
      return [];
    }

    const choices = (reply as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices)) {
      logger.warn('[intempt] choose: reply has no choices array, returning no choices');
      return [];
    }
    return choices.flatMap((item): Choice[] => {
      const row = item as Record<string, unknown> | null;
      if (typeof row?.name !== 'string') return [];
      return [
        compact({
          name: row.name,
          group: typeof row.group === 'string' ? row.group : undefined,
          body: row.body,
          experienceId:
            typeof row.experienceId === 'number' ? row.experienceId : undefined,
          variantId: typeof row.variantId === 'number' ? row.variantId : undefined,
          reason: typeof row.reason === 'string' ? row.reason : undefined,
        }),
      ];
    });
  }

  /** Same identity rule as the flag routes: a non-blank `userId`, or a `profileId` with a configured `sourceId`. */
  #validate(context: ChooseContext, options: ChooseOptions): void {
    const { sourceId } = this.#deps.config();
    if (
      !present(context?.userId) &&
      !(present(context?.profileId) && present(sourceId))
    ) {
      throw new TypeError(
        'choose: context needs either userId, or profileId together with a sourceId configured on the client',
      );
    }
    for (const [field, values] of [
      ['names', options.names],
      ['groups', options.groups],
    ] as const) {
      if (values === undefined) continue;
      if (!Array.isArray(values)) {
        throw new TypeError(`choose: ${field} must be an array of strings`);
      }
      for (const value of values) {
        if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
          throw new TypeError(
            `choose: ${field} entries must match ${NAME_PATTERN.source}, got ${JSON.stringify(value)}`,
          );
        }
      }
    }
  }

  /**
   * Leaving out `names` AND `groups` is not "ask for everything", it is "evaluate everything", and
   * on this endpoint an evaluation IS an exposure. `ExperienceChooserService.chooseApi` passes a
   * null `names` into `retrieveApiExperiences`, which returns every api-channel experience the
   * person is eligible for; each flows through `VariantChooserService.chooseVariants` -> `choose`
   * -> `publishAndParse` -> `ChooserHelper.publishEvent` -> `publishExperienceChoose` on EVERY
   * call, not only on first assignment. Two things break at once:
   *
   *  - every running server experiment's denominator fills with people who never saw the variant,
   *    uniformly across arms, so it reads as an experiment that stopped detecting rather than as a
   *    broken one; and
   *  - `ChooserHelper.display` calls `saveSession` for each variant, so a `once` experience is
   *    marked displayed for keys nobody rendered, `allowOnce` is false from then on, the experience
   *    drops out of `choices` forever, and the caller gets nothing, indistinguishably from an
   *    outage.
   *
   * `exposure: false` asks the service to evaluate without spending a ONCE gate or publishing
   * (CONTRACT-R2 §S4); a backend that predates the field ignores it and records anyway. Always pass
   * `names` or `groups` on anything that runs per request.
   *
   * Bounded by `flagTimeout`, not `timeout`: this is a render-path read, so it must fall back to
   * `[]` as fast as a flag read does (D19).
   */
  async #request(
    context: ChooseContext,
    options: ChooseOptions,
  ): Promise<{ body: unknown }> {
    const { sourceId } = this.#deps.config();
    const body = compact({
      identification: compact({
        userId: context.userId,
        profileId: context.profileId,
        sourceId,
      }),
      names: options.names,
      groups: options.groups,
      device: 'all',
      sessionId: context.sessionId,
      exposure: options.disableExposure === true ? false : undefined,
    });
    return this.#deps.transport.post(
      this.#deps.transport.projectPath('/optimization/choose-api'),
      body,
      { timeout: this.#deps.config().flagTimeout },
    );
  }
}
