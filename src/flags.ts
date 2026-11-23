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

/** OpenFeature error codes, set with `reason: 'error'` when the default came back for a known cause. */
export type FlagErrorCode =
  'FLAG_NOT_FOUND' | 'TYPE_MISMATCH' | 'TARGETING_KEY_MISSING' | 'GENERAL';

export interface FlagDetail<T> {
  value: T;
  reason: FlagReason;
  errorCode?: FlagErrorCode;
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
  /** Overrides CACHE_MAX; exists so the eviction order can be tested without 10,000 requests. */
  cacheMax?: number;
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

type FlagValueType = 'boolean' | 'string' | 'number' | 'json';

/**
 * The type a read expects, from its default (F30 #2). A `null` default expects nothing in
 * particular: it is the caller saying "absent", not naming a type, so any served value is returned.
 */
function expectedType(defaultValue: unknown): FlagValueType | undefined {
  const type = typeof defaultValue;
  if (type === 'boolean' || type === 'string' || type === 'number') return type;
  return type === 'object' && defaultValue !== null ? 'json' : undefined;
}

/**
 * The server's declared `valueType` decides when sent (F30 #3); the JavaScript type is checked as
 * well, so a malformed answer cannot pass as its declared type. Any JSON value, arrays and scalars
 * included, is a `json` value (F30 #4).
 */
function matches(expected: FlagValueType, value: unknown, valueType?: string): boolean {
  if (valueType !== undefined && valueType !== expected) return false;
  if (expected === 'json') return true;
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
}

const WARNED_MAX = 1_000;

/**
 * F15 without a stream (X6 is not built): the last-known value is served only when a read fails,
 * for up to 24 h, at most 10,000 entries per client. The 60 s cache of the row is only valid while
 * a stream can drop changed keys, so it is not used here.
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CACHE_MAX = 10_000;

/**
 * Failures the service may recover from. Not a 400/404 (the request or the flag is wrong, and a
 * deleted flag must stop serving) and not a 401/403 (a misconfigured key is not an outage).
 */
const FALLBACK_KINDS: ReadonlySet<FlagErrorKind> = new Set([
  'timeout',
  'network',
  'server',
  'parse',
]);

/**
 * The identity the server buckets on: source + profile when both are present, else the user
 * (`Identification.hasProfile`). JSON-encoded so no key/id pair can collide with another.
 */
function cacheKey(
  key: string,
  context: FlagContext,
  sourceId: string | undefined,
): string {
  const profileId = context.profileId;
  return typeof profileId === 'string' &&
    profileId.trim() !== '' &&
    sourceId !== undefined
    ? JSON.stringify([key, 'profile', sourceId, profileId])
    : JSON.stringify([key, 'user', context.userId]);
}

/** The detail for an answered (or cached) flag, with the F30 type check against the default. */
function typed<T>(flag: RawFlag, defaultValue: T, reason?: FlagReason): FlagDetail<T> {
  const value = flag.value;
  const fields = { ...answer(flag), ...(reason === undefined ? {} : { reason }) };
  if (value === undefined || value === null) {
    return { value: defaultValue, ...fields };
  }
  const expected = expectedType(defaultValue);
  if (expected !== undefined && !matches(expected, value, fields.valueType)) {
    return {
      value: defaultValue,
      ...fields,
      reason: 'error',
      errorCode: 'TYPE_MISMATCH',
    };
  }
  return { value: value as T, ...fields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class Flags {
  readonly #deps: FlagsDeps;
  #authLogged = false;
  readonly #warned = new Set<string>();
  readonly #cache = new Map<string, { flag: RawFlag; at: number }>();
  readonly #cacheMax: number;

  constructor(deps: FlagsDeps) {
    this.#deps = deps;
    this.#cacheMax = deps.cacheMax ?? CACHE_MAX;
  }

  async detail<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<FlagDetail<T>> {
    // S11: a caller mistake returns the default, never throws; one warning per key keeps it visible.
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      this.#warnOnce(
        `key:${String(key)}`,
        `[intempt] flag key "${String(key)}" is empty or does not match ${KEY_PATTERN.source} ` +
          "(the platform's own pattern); returning the default",
      );
      return { value: defaultValue, reason: 'error', errorCode: 'FLAG_NOT_FOUND' };
    }
    if (defaultValue === undefined) {
      this.#warnOnce(
        `default:${key}`,
        `[intempt] flag "${key}" was read without a default`,
      );
      return { value: defaultValue, reason: 'error', errorCode: 'GENERAL' };
    }
    if (!this.#answerable(context, key)) {
      return { value: defaultValue, reason: 'error', errorCode: 'TARGETING_KEY_MISSING' };
    }

    const { flag, error } =
      options?.disableExposure === true
        ? await this.#unexposed(context, key)
        : await this.#evaluate(context, key);
    const id = cacheKey(key, context, this.#deps.config().sourceId);
    if (error) {
      const cached = FALLBACK_KINDS.has(error.kind) ? this.#recall(id) : undefined;
      if (cached) return typed(cached, defaultValue, 'cached');
      const errorCode = error.status === 404 ? 'FLAG_NOT_FOUND' : 'GENERAL';
      // A deleted flag must not come back from the cache during a later outage.
      if (errorCode === 'FLAG_NOT_FOUND') this.#cache.delete(id);
      return { value: defaultValue, reason: 'error', errorCode, error };
    }
    if (flag === undefined) {
      // Only a disableExposure read gets here: `/flags/all` leaves an unknown key out of its answer
      // where `/flags/evaluate` would answer 404.
      this.#cache.delete(id);
      return { value: defaultValue, reason: 'error', errorCode: 'FLAG_NOT_FOUND' };
    }
    if (flag.value === undefined || flag.value === null) {
      // Off, killed or not targeted: forgotten, so an outage cannot serve the old value again.
      this.#cache.delete(id);
    } else {
      this.#remember(id, flag);
    }
    return typed(flag, defaultValue);
  }

  /** Re-inserted on every write so Map order is age order and the first key is the oldest. */
  #remember(id: string, flag: RawFlag): void {
    this.#cache.delete(id);
    this.#cache.set(id, { flag, at: Date.now() });
    if (this.#cache.size > this.#cacheMax) {
      this.#cache.delete(this.#cache.keys().next().value as string);
    }
  }

  #recall(id: string): RawFlag | undefined {
    const entry = this.#cache.get(id);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.#cache.delete(id);
      return undefined;
    }
    return entry.flag;
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

  // The typed calls are `value` with a typed default: the default's type is the expected type, so
  // a wrong-typed value comes back as the default and is never coerced (`!!"false"` is true).
  bool(
    key: string,
    context: FlagContext,
    defaultValue: boolean,
    options?: VariationOptions,
  ): Promise<boolean> {
    return this.value(key, context, defaultValue, options);
  }

  string(
    key: string,
    context: FlagContext,
    defaultValue: string,
    options?: VariationOptions,
  ): Promise<string> {
    return this.value(key, context, defaultValue, options);
  }

  number(
    key: string,
    context: FlagContext,
    defaultValue: number,
    options?: VariationOptions,
  ): Promise<number> {
    return this.value(key, context, defaultValue, options);
  }

  /** Any JSON value, arrays and scalars included (F30 #4); `T` is the caller's assertion of shape. */
  json<T = unknown>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    return this.value(key, context, defaultValue, options);
  }

  /**
   * Every flag served to this person, as a key -> value map. `/flags/all` publishes no exposure, so
   * this is safe to call; a flag that was not served is absent rather than mapped to a value.
   */
  async all(context: FlagContext): Promise<Record<string, unknown>> {
    if (!this.#answerable(context, null)) return {};

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
   * Whether the service can resolve this context. The flag routes take choose-api's
   * `Identification` and answer 400 unless it names a visitor: a non-blank `userId`, or a `sourceId`
   * with a non-blank `profileId` (`hasAnonymousId`). Checked here so the caller is told why, once
   * per key, instead of a 400 per call (S11: TARGETING_KEY_MISSING, never a throw).
   *
   * `accountId` is the trap worth naming: `FlagContext extends Identifiers`, so TypeScript accepts
   * it, and the request carries only `userId`/`profileId`/`sourceId`.
   */
  #answerable(context: FlagContext, key: string | null): boolean {
    const present = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
    const { sourceId } = this.#deps.config();

    if (present(context?.userId)) return true;
    if (present(context?.profileId) && present(sourceId)) return true;

    const hadAccountOnly = present(
      (context as { accountId?: string } | undefined)?.accountId,
    );
    this.#warnOnce(
      `identity:${key}`,
      `[intempt] flag "${key ?? '(allFlags)'}": context needs either userId, or profileId ` +
        'together with a sourceId configured on the client; returning the default' +
        (hadAccountOnly
          ? '. accountId is not an identifier the serving endpoint accepts'
          : ''),
    );
    return false;
  }

  /**
   * Bounded so a stream of distinct bad keys cannot grow memory: when full it starts over, and a
   * key seen long ago may warn once more rather than never.
   */
  #warnOnce(id: string, message: string): void {
    if (this.#warned.has(id)) return;
    if (this.#warned.size >= WARNED_MAX) this.#warned.clear();
    this.#warned.add(id);
    this.#deps.config().logger.warn(message);
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
   * `context`: `#answerable` has already rejected an absent one.
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
      {
        timeout: this.#deps.config().flagTimeout,
      },
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

  async jsonVariation<T = unknown>(
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
