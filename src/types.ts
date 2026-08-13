import type { Agent } from 'node:http';

/** Minimal logger contract. `console` satisfies it. */
export interface Logger {
  trace(message?: unknown, ...args: unknown[]): void;
  debug(message?: unknown, ...args: unknown[]): void;
  info(message?: unknown, ...args: unknown[]): void;
  warn(message?: unknown, ...args: unknown[]): void;
  error(message?: unknown, ...args: unknown[]): void;
}

export interface BatchOptions {
  /** Events buffered before an automatic flush. */
  size?: number;
  /** Milliseconds between automatic flushes. */
  flushMs?: number;
  /** Hard ceiling on buffered events; further events are dropped and logged. */
  maxQueue?: number;
  /** Flush any remaining events on `process.beforeExit`. Default true. */
  flushOnExit?: boolean;
}

export interface IntemptConfig {
  org: string;
  project: string;
  /** Public API key, in `<prefix>.<secret>` form. */
  apiKey: string;
  /**
   * Ingestion source. When present, events go to `/sources/{sourceId}/track`.
   * Required by the server for consent records that identify by `profileId`.
   */
  sourceId?: string;
  host?: string;
  protocol?: 'http' | 'https';
  /** Path prefix before `/v1`. Empty by default. */
  path?: string;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  keepAlive?: boolean;
  logger?: Logger;
  debug?: boolean;
  /**
   * `false` (default) sends one request per call and resolves when the server
   * responds. An object enables buffering; see `flush()` and `close()`.
   */
  batch?: false | BatchOptions;
  /**
   * Hard ceiling on events per HTTP request, applied in both modes. The
   * server's real ceiling is not published, so this is a client-side guess that
   * 413 responses halve at runtime.
   */
  maxRequestEvents?: number;
  /**
   * How many requests a single `trackBatch()` may have in flight at once.
   * Defaults to 1 (sequential). Raising it trades bandwidth for wall-clock on
   * large batches.
   */
  maxConcurrentRequests?: number;
  /**
   * Supply your own agent to control TLS: a private CA, a client certificate
   * for mTLS, or an explicit proxy policy. When set, the SDK does not create
   * keep-alive agents and ignores `keepAlive`, `HTTPS_PROXY` and `HTTP_PROXY` —
   * the agent you pass is used verbatim.
   */
  agent?: Agent;
}

export interface ResolvedBatchOptions extends Required<BatchOptions> {}

export interface ResolvedConfig {
  org: string;
  project: string;
  sourceId?: string;
  host: string;
  port?: number;
  protocol: 'http' | 'https';
  path: string;
  timeout: number;
  keepAlive: boolean;
  logger: Logger;
  debug: boolean;
  batch: false | ResolvedBatchOptions;
  maxRequestEvents: number;
  maxConcurrentRequests: number;
  agent?: Agent;
}

/**
 * At least one of these must be present.
 *
 * - `userId` — your own identifier for a person: an email, an internal user id.
 * - `accountId` — your own identifier for a company or account.
 *
 * Those are the only two identifiers this SDK accepts, and both are values you
 * already own. Two platform identifiers are deliberately NOT exposed:
 *
 * - `profileId` is the anonymous id the browser SDK mints and keeps on the
 *   device. A server that invents one creates an orphan profile that never
 *   stitches to a real visitor.
 * - `masterId` is assigned internally after identity resolution. There is no
 *   way to look one up from here, and a hardcoded one breaks the moment two
 *   profiles merge.
 *
 * The platform resolves identity from `userId` on its own: it sets
 * `profileId = userId` when only `userId` is given.
 */
export interface Identifiers {
  userId?: string;
  accountId?: string;
}

/**
 * Adds the anonymous browser profile id.
 *
 * Internal, and deliberately NOT part of any option type a v2 caller can reach.
 * It exists for the deprecated 1.x `SDK` shim, whose whole surface was
 * profileId-first and whose callers' data is already keyed that way.
 *
 * The v2 option types below extend `Identifiers`, not this. They used to extend
 * this one, which put `profileId` back on the public surface by structural
 * typing — `client.track('e', { profileId })` compiled — contradicting both the
 * comment on `Identifiers` and the README. Widening a public option type is not
 * the way to feed an internal field: see `InternalTrackOptions` and friends in
 * ingest.ts for the pattern, which consent.ts already used.
 *
 * @internal
 */
export interface LegacyIdentifiers extends Identifiers {
  profileId?: string;
}

export type Properties = Record<string, unknown>;

export interface TrackOptions extends Identifiers {
  properties?: Properties;
  userAttributes?: Properties;
  accountAttributes?: Properties;
  /** Event time as a `Date` or epoch milliseconds. Defaults to now. */
  timestamp?: Date | number;
}

export interface TrackEvent extends TrackOptions {
  event: string;
}

export interface IdentifyOptions extends Identifiers {
  traits?: Properties;
  /** Override the reserved event name. */
  event?: string;
  timestamp?: Date | number;
}

export interface GroupOptions extends Identifiers {
  accountId: string;
  attributes?: Properties;
  event?: string;
  timestamp?: Date | number;
}

export interface AliasOptions extends Identifiers {
  userId: string;
  previousUserId: string;
  timestamp?: Date | number;
}

export interface ConsentOptions {
  userId?: string;
  category?: string;
  /** ISO date, epoch string, or `'unlimited'` (default). */
  validUntil?: string;
  email?: string;
  message?: string;
  reason?: string;
  method?: string;
  deviceInfo?: string;
  /** Consent time as a `Date` or epoch milliseconds. Sent to the API in seconds. */
  timestamp?: Date | number;
}

/**
 * Identify with exactly one of `userId` or `accountId`. The feeds API resolves a
 * single entity from an `{id, type}` pair, so the two are mutually exclusive
 * here, unlike on the tracking calls.
 */
export interface RecommendOptions extends Identifiers {
  feedId: string;
  /** Product attribute names from your catalog schema. */
  fields: string[];
  limit?: number;
  productId?: string;
}

export interface ProductLine {
  productId: string;
  quantity?: number;
}

/** One `{name, payload}` group as accepted by the track endpoint. */
export interface WirePayloadItem {
  eventId: string;
  timestamp: number;
  profileId?: string;
  userId?: string;
  accountId?: string;
  data?: Properties;
  userAttributes?: Properties;
  accountAttributes?: Properties;
  anotherUserId?: string;
}

export interface WireEvent {
  name: string;
  payload: WirePayloadItem[];
}
