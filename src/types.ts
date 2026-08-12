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
}

/**
 * At least one of these must be present. The server sets
 * `profileId = userId` when only `userId` is given.
 */
export interface Identifiers {
  userId?: string;
  profileId?: string;
  accountId?: string;
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
  profileId?: string;
  masterId?: string | number;
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

export type OptimizationType = 'experiment' | 'personalization';

export interface ExperiencesOptions extends Identifiers {
  type: OptimizationType;
  groups?: string[];
  names?: string[];
  device?: string;
}

export interface RecommendOptions extends Identifiers {
  feedId: string;
  limit: number;
  fields: string[];
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
