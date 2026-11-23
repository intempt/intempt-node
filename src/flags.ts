import type { Identifiers, IntemptConfig, ResolvedConfig } from './types';
import { compact } from './utils';
import { resolveConfig } from './config';
import { ApiKeyCredentials } from './credentials';
import { IntemptApiError, Transport } from './transport';

/**
 * Feature flags, read by key from audience-service's flag routes (F32).
 *
 * This module is the whole flag surface (F33). It imports only the shared core -- config,
 * credentials, transport, utils and types -- and nothing from tracking, so the `./flags` entry can
 * run with the batcher, ingest, delivery and consent modules absent (tests/flags-standalone.test.ts
 * proves it on the built output). `IntemptClient` keeps its flag methods by delegating here.
 *
 * The cross-SDK rules that shape it (`intempt-swift/docs/SDK-API-CONTRACT.md`):
 *
 *  1. `defaultValue` is REQUIRED. It is what a caller receives on a network failure, a timeout, an
 *     unknown key or a malformed response. Optional is how `undefined` reaches production during an
 *     outage.
 *  2. `variationDetail` tells a failed read from an answered one: `reason: 'error'` plus a
 *     `FlagError` when the default was returned because the call failed.
 *  3. Evaluation is REMOTE only. There is no local rule engine and no flag store to poll.
 *
 * A flag is never evaluated through `/optimization/choose-api` here; that route stays for
 * experiments and personalizations, which this SDK does not serve.
 */

/**
 * Route suffixes under `/v1/{org}/projects/{project}`, as audience-service declares them
 * (`OptimizationChooserRoutes`, 358d07d). The gateway routes for them are not built yet, so the
 * external path is unsettled: if the gateway exposes them elsewhere, this is the one place to change.
 */
const FLAG_ROUTES = { evaluate: '/flags/evaluate', all: '/flags/all' } as const;

/**
 * Why an evaluation returned the value it did: the server's reason, passed through unmapped (F6),
 * or `error` when the read failed. Open to strings this SDK has not seen, so a reason the server
 * adds later reaches the caller instead of failing a type guard.
 */
export type FlagReason =
  | 'targeted'
  | 'not_targeted'
  | 'not_in_rollout'
  | 'off'
  | 'killed'
  | 'not_client_side'
  | 'holdout'
  | 'error'
  | (string & {});

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
   * The anonymous/device identifier, when the caller has one, paired with the client's `sourceId`.
   *
   * **When supplied, this is the identifier the platform buckets on and `userId` is ignored**
   * (choose-api's `Identification`, which the flag routes share). Pass both and assignment is
   * device-scoped, and the day the caller stops passing it every person re-buckets in one deploy.
   * Pass ONE identifier and hold it constant.
   */
  profileId?: string;

  /**
   * @deprecated Ignored. The flag routes take no session (F32: F7 forbids a session fallback for
   * flags, so the field was removed rather than ignored on the server). Kept so existing callers
   * still compile.
   */
  sessionId?: string;
}

/** Per-read options for `variation`, `variationDetail` and the typed helpers. */
export interface VariationOptions {
  /**
   * Evaluate without recording an exposure: for a read that does not show the value, such as a
   * pre-render or a prefetch. The read goes to `/flags/all` with this one key, which publishes
   * nothing; without it the read goes to `/flags/evaluate`, which records the exposure.
   */
  disableExposure?: boolean;
}

export interface FlagDetail<T> {
  value: T;
  reason: FlagReason;
  /** The served variation; absent when nothing was served or the server did not send it. */
  variationId?: number;
  /** The flag's declared type: `boolean`, `string`, `number` or `json`. */
  valueType?: string;
  /** Present only when `reason` is `error`. */
  error?: FlagError;
}

/** audience-service `FlagValue`. Every field optional: an older or partial answer must not crash. */
interface RawFlag {
  key?: unknown;
  value?: unknown;
  variationId?: unknown;
  valueType?: unknown;
  reason?: unknown;
}

/** Config for the flags-only client: the shared core, without the tracking options. */
export type IntemptFlagsConfig = Omit<
  IntemptConfig,
  'batch' | 'maxRequestEvents' | 'maxConcurrentRequests' | 'onDeliveryFailure'
>;

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

/** An answer without a reason (an older server, F6 #4) reads `off`, as every answer did before. */
const UNANSWERED: FlagReason = 'off';

/** The answer fields of a well-formed `FlagValue`; a field of the wrong type is dropped, not trusted. */
function answer(flag: RawFlag | undefined): Omit<FlagDetail<unknown>, 'value' | 'error'> {
  return {
    reason:
      typeof flag?.reason === 'string' && flag.reason !== '' ? flag.reason : UNANSWERED,
    ...(typeof flag?.variationId === 'number' ? { variationId: flag.variationId } : {}),
    ...(typeof flag?.valueType === 'string' ? { valueType: flag.valueType } : {}),
  };
}

/** The platform's own key pattern (`FlagEvaluateRequest.key`), tightened to `+`: blank is rejected first. */
const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class Flags {
  readonly #deps: FlagsDeps;
  #authLogged = false;

  constructor(deps: FlagsDeps) {
    this.#deps = deps;
  }

  async detail<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<FlagDetail<T>> {
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('variation: key is required');
    }
    if (!KEY_PATTERN.test(key)) {
      // A key the service will reject is a programming error, and it must fail here rather than
      // 400 downstream, where it would be indistinguishable from an outage.
      throw new TypeError(
        `variation: key must match ${KEY_PATTERN.source} (the platform's own pattern); got "${key}"`,
      );
    }
    if (defaultValue === undefined) {
      throw new TypeError('variation: defaultValue is required');
    }
    this.#assertAnswerable(context);

    const { flag, error } =
      options?.disableExposure === true
        ? await this.#unexposed(context, key)
        : await this.#evaluate(context, key);
    if (error) {
      return { value: defaultValue, reason: 'error', error };
    }
    const value = flag?.value;
    if (value === undefined || value === null) {
      return { value: defaultValue, ...answer(flag) };
    }
    return { value: value as T, ...answer(flag) };
  }

  async value<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    const { value } = await this.detail<T>(key, context, defaultValue, options);
    return value;
  }

  async bool(
    key: string,
    context: FlagContext,
    defaultValue: boolean,
    options?: VariationOptions,
  ): Promise<boolean> {
    const value = await this.value<unknown>(key, context, defaultValue, options);
    // A served value of the wrong type is a misconfiguration, not something to coerce: `!!"false"`
    // is true, and a silent coercion would be indistinguishable from a correct answer.
    return typeof value === 'boolean' ? value : defaultValue;
  }

  async string(
    key: string,
    context: FlagContext,
    defaultValue: string,
    options?: VariationOptions,
  ): Promise<string> {
    const value = await this.value<unknown>(key, context, defaultValue, options);
    return typeof value === 'string' ? value : defaultValue;
  }

  async number(
    key: string,
    context: FlagContext,
    defaultValue: number,
    options?: VariationOptions,
  ): Promise<number> {
    const value = await this.value<unknown>(key, context, defaultValue, options);
    return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  }

  async json<T extends object>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    const value = await this.value<unknown>(key, context, defaultValue, options);
    return value !== null && typeof value === 'object' ? (value as T) : defaultValue;
  }

  /**
   * Every flag served to this person, as a key -> value map. `/flags/all` publishes no exposure, so
   * this is safe to call; a flag that was not served is absent rather than mapped to a value.
   */
  async all(context: FlagContext): Promise<Record<string, unknown>> {
    this.#assertAnswerable(context);

    const out: Record<string, unknown> = {};
    const { flags } = await this.#all(context, undefined, null);
    for (const flag of flags) {
      if (typeof flag.key === 'string' && flag.key !== '') {
        out[flag.key] = flag.value ?? null;
      }
    }
    return out;
  }

  /**
   * A context the service cannot resolve is a caller mistake, so it throws here.
   *
   * The flag routes take choose-api's `Identification` and answer 400 unless it names a visitor:
   * a non-blank `userId`, or a `sourceId` with a non-blank `profileId` (`hasAnonymousId`). Without
   * this check that 400 would be absorbed into the caller's default for every key, forever.
   *
   * `accountId` is the trap worth naming: `FlagContext extends Identifiers`, so TypeScript accepts
   * it, and the request carries only `userId`/`profileId`/`sourceId`.
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

  /** `/flags/evaluate`: exactly one key; the server records the exposure. */
  async #evaluate(
    context: FlagContext,
    key: string,
  ): Promise<{ flag?: RawFlag; error?: FlagError }> {
    let body: unknown;
    try {
      body = (await this.#post(FLAG_ROUTES.evaluate, { ...this.#request(context), key }))
        .body;
    } catch (error) {
      return { error: this.#failed(classify(key, error), error) };
    }
    if (!isRecord(body)) {
      return { error: this.#failed({ key, kind: 'parse' }, body) };
    }
    return { flag: body };
  }

  /** `/flags/all` with one key: evaluates without publishing, for `disableExposure`. */
  async #unexposed(
    context: FlagContext,
    key: string,
  ): Promise<{ flag?: RawFlag; error?: FlagError }> {
    const { flags, error } = await this.#all(context, [key], key);
    if (error) return { error };
    return { flag: flags.find((f) => f.key === key) };
  }

  async #all(
    context: FlagContext,
    keys: string[] | undefined,
    errorKey: string | null,
  ): Promise<{ flags: RawFlag[]; error?: FlagError }> {
    let body: unknown;
    try {
      body = (await this.#post(FLAG_ROUTES.all, { ...this.#request(context), keys }))
        .body;
    } catch (error) {
      return { flags: [], error: this.#failed(classify(errorKey, error), error) };
    }
    const flags = isRecord(body) ? body.flags : undefined;
    if (!Array.isArray(flags)) {
      return { flags: [], error: this.#failed({ key: errorKey, kind: 'parse' }, body) };
    }
    return { flags: flags.filter(isRecord) };
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
   * choose-api's `Identification` minus `masterId` (Beso, 2026-11-20). No optional chaining on
   * `context`: `#assertAnswerable` has already rejected an absent one.
   */
  #request(context: FlagContext): Record<string, unknown> {
    const { sourceId } = this.#deps.config();
    return {
      identification: compact({
        userId: context.userId,
        profileId: context.profileId,
        sourceId,
      }),
      device: 'all',
    };
  }

  #post(route: string, body: Record<string, unknown>): Promise<{ body: unknown }> {
    return this.#deps.transport.post(
      this.#deps.transport.projectPath(route),
      compact(body),
    );
  }
}

/**
 * The flags-only client (`intempt-nodejs-sdk/flags`): the flag surface of `IntemptClient`, on its
 * own transport, with no batcher, queue or exit hook. For a backend that only checks flags.
 */
export class IntemptFlagsClient {
  readonly #transport: Transport;
  readonly #flags: Flags;
  #closed = false;

  constructor(config: IntemptFlagsConfig) {
    const resolved = resolveConfig(config);
    const credentials = new ApiKeyCredentials(config.apiKey);
    this.#transport = new Transport(resolved, credentials);
    this.#flags = new Flags({
      transport: this.#transport,
      config: () => resolved,
      keyPrefix: credentials.prefix,
    });
  }

  async variation<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    this.#assertOpen();
    return this.#flags.value<T>(key, context, defaultValue, options);
  }

  async variationDetail<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<FlagDetail<T>> {
    this.#assertOpen();
    return this.#flags.detail<T>(key, context, defaultValue, options);
  }

  async boolVariation(
    key: string,
    context: FlagContext,
    defaultValue: boolean,
    options?: VariationOptions,
  ): Promise<boolean> {
    this.#assertOpen();
    return this.#flags.bool(key, context, defaultValue, options);
  }

  async stringVariation(
    key: string,
    context: FlagContext,
    defaultValue: string,
    options?: VariationOptions,
  ): Promise<string> {
    this.#assertOpen();
    return this.#flags.string(key, context, defaultValue, options);
  }

  async numberVariation(
    key: string,
    context: FlagContext,
    defaultValue: number,
    options?: VariationOptions,
  ): Promise<number> {
    this.#assertOpen();
    return this.#flags.number(key, context, defaultValue, options);
  }

  async jsonVariation<T extends object>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    this.#assertOpen();
    return this.#flags.json(key, context, defaultValue, options);
  }

  async allFlags(context: FlagContext): Promise<Record<string, unknown>> {
    this.#assertOpen();
    return this.#flags.all(context);
  }

  /** Releases keep-alive sockets. The client is unusable after. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#transport.destroy();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(
        'Intempt flags client is closed. Calls after close() are not sent; create a new client.',
      );
    }
  }
}

export const IntemptFlags = {
  /** Creates a flags-only client. Nothing is sent until you call a method. */
  init(config: IntemptFlagsConfig): IntemptFlagsClient {
    return new IntemptFlagsClient(config);
  },
};

export { IntemptApiError };
