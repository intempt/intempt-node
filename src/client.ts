import { mergeConfig, resolveConfig } from './config';
import { ApiKeyCredentials } from './credentials';
import { Transport } from './transport';
import { Batcher } from './batcher';
import { Ingest } from './ingest';
import { Consent } from './consent';
import { Ecommerce } from './ecommerce';
import { Recommend } from './recommend';
import { Flags } from './flags';
import type { FlagContext } from './flags';
import type {
  AliasOptions,
  GroupOptions,
  IdentifyOptions,
  IntemptConfig,
  RecommendOptions,
  ResolvedConfig,
  TrackEvent,
  TrackOptions,
} from './types';

export class IntemptClient {
  #resolved: ResolvedConfig;
  readonly #transport: Transport;
  readonly #batcher: Batcher | undefined;
  readonly #ingest: Ingest;
  #optedIn = true;
  #closed = false;

  readonly consent: Consent;
  readonly ecommerce: Ecommerce;
  readonly #recommend: Recommend;
  readonly #flags: Flags;

  constructor(config: IntemptConfig) {
    this.#resolved = resolveConfig(config);
    this.#transport = new Transport(this.#resolved, new ApiKeyCredentials(config.apiKey));

    const configRef = (): ResolvedConfig => this.#resolved;
    // Two distinct conditions, deliberately not folded together: opting out is a
    // silent no-op by design, while using a closed client is a programming error
    // and must be loud.
    const isOptedIn = (): boolean => this.#optedIn && !this.#closed;
    const assertOpen = (): void => this.#assertOpen();

    this.#ingest = new Ingest({
      transport: this.#transport,
      config: configRef,
      batcher: () => this.#batcher,
      isOptedIn,
      assertOpen,
    });

    if (this.#resolved.batch !== false) {
      this.#batcher = new Batcher({
        options: this.#resolved.batch,
        maxRequestEvents: this.#resolved.maxRequestEvents,
        logger: this.#resolved.logger,
        send: (events) => this.#ingest.send(events),
      });
    }

    this.consent = new Consent({
      transport: this.#transport,
      config: configRef,
      isOptedIn,
      assertOpen,
    });
    this.ecommerce = new Ecommerce(this.#ingest);
    this.#recommend = new Recommend({ transport: this.#transport, config: configRef });
    this.#flags = new Flags({ transport: this.#transport, config: configRef });
  }

  // ---- ingest, lifted to the top level so the common calls stay short ----

  track(event: string, options: TrackOptions): Promise<void> {
    return this.#ingest.track(event, options);
  }

  trackBatch(events: TrackEvent[]): Promise<void> {
    return this.#ingest.trackBatch(events);
  }

  identify(options: IdentifyOptions): Promise<void> {
    return this.#ingest.identify(options);
  }

  group(options: GroupOptions): Promise<void> {
    return this.#ingest.group(options);
  }

  alias(options: AliasOptions): Promise<void> {
    return this.#ingest.alias(options);
  }

  // ---- decisions out ----

  /**
   * Product recommendations from a feed.
   *
   * Experiments and personalizations are deliberately absent: they resolve a
   * web experience against a page, and are served by the browser SDK. A server
   * has no page to modify.
   */
  async recommend(options: RecommendOptions): Promise<unknown> {
    // Gated like every other method. It was the one public call with no check,
    // so it kept working after close() — and since close() destroys the agents,
    // and Agent.destroy() only reaps *idle* sockets, the call opened a fresh
    // socket that nothing would ever release. That contradicted the close()
    // contract two lines of doc away from it.
    //
    // `async` so the guard surfaces as a rejection. Every other method reaches an
    // async body before throwing, and a lone synchronous throw here would escape
    // a caller's `.catch()` and land as an uncaught exception instead.
    this.#assertOpen();
    return this.#recommend.fetch(options);
  }

  // ---- flags ----

  /**
   * The value assigned to this person for `key`, or `defaultValue` if the service did not answer.
   *
   * Ask for a key, never a mode. Whether the key names an experiment, a personalization or a flag
   * is the platform's business - its serving query filters on channel and status and never on mode.
   */
  async variation<T>(key: string, context: FlagContext, defaultValue: T): Promise<T> {
    this.#assertOpen();
    return this.#flags.value<T>(key, context, defaultValue);
  }

  /** Every key assigned to this person, in one call. */
  async allFlags(context: FlagContext): Promise<Record<string, unknown>> {
    this.#assertOpen();
    return this.#flags.all(context);
  }

  async boolVariation(
    key: string,
    context: FlagContext,
    defaultValue: boolean,
  ): Promise<boolean> {
    const value = await this.variation<unknown>(key, context, defaultValue);
    // A served value of the wrong type is a misconfiguration, not something to coerce: `!!"false"`
    // is true, and a silent coercion would be indistinguishable from a correct answer.
    return typeof value === 'boolean' ? value : defaultValue;
  }

  async stringVariation(
    key: string,
    context: FlagContext,
    defaultValue: string,
  ): Promise<string> {
    const value = await this.variation<unknown>(key, context, defaultValue);
    return typeof value === 'string' ? value : defaultValue;
  }

  async numberVariation(
    key: string,
    context: FlagContext,
    defaultValue: number,
  ): Promise<number> {
    const value = await this.variation<unknown>(key, context, defaultValue);
    return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  }

  async jsonVariation<T extends object>(
    key: string,
    context: FlagContext,
    defaultValue: T,
  ): Promise<T> {
    const value = await this.variation<unknown>(key, context, defaultValue);
    return value !== null && typeof value === 'object' ? (value as T) : defaultValue;
  }

  /**
   * Resolves immediately.
   *
   * Present so the cross-SDK surface is the same everywhere, and so a caller porting from an SDK
   * that polls a local flag store does not have to remove the call. Evaluation here is remote: each
   * `variation()` is a request, so there is no local state to wait for. It is deliberately not a
   * no-op that swallows a timeout argument silently - the doc says why there is nothing to wait for.
   */
  async waitForInitialization(_timeoutMs?: number): Promise<void> {
    this.#assertOpen();
  }

  // ---- privacy ----

  /**
   * Re-enables sending. Note this gates every write namespace, not only
   * tracking: consent records are suppressed too while opted out.
   */
  optIn(): void {
    this.#optedIn = true;
  }

  /**
   * Suppresses all outbound writes: track, batch, commerce and consent.
   * `recommend()` is unaffected — it sends an identifier the caller already holds
   * and returns a decision rather than storing anything. (It is still refused
   * after close(), which is a different condition: opting out is a policy choice,
   * a closed client is a programming error.)
   */
  optOut(): void {
    this.#optedIn = false;
  }

  isOptedIn(): boolean {
    return this.#optedIn && !this.#closed;
  }

  // ---- config ----

  /**
   * `keepAlive` and `agent` are refused, matching `mergeConfig`, which throws on
   * either. They were previously accepted by this type and rejected at runtime, so
   * `setConfig({ keepAlive: false })` compiled clean and then threw. A fixed option
   * belongs in the signature, not in an exception.
   *
   * Declared `never` rather than merely `Omit`ted, because excess-property checks
   * only fire on fresh object literals: a `Partial<IntemptConfig>` variable
   * carrying `keepAlive` still compiled and still threw.
   */
  setConfig(
    patch: Partial<
      Omit<
        IntemptConfig,
        'org' | 'project' | 'apiKey' | 'sourceId' | 'batch' | 'keepAlive' | 'agent'
      >
    > & { keepAlive?: never; agent?: never },
  ): void {
    this.#resolved = mergeConfig(this.#resolved, patch);
    this.#transport.setConfig(this.#resolved);
  }

  /**
   * A frozen snapshot. Mutating it cannot change the client.
   *
   * `batch` is copied and frozen too: a shallow freeze shared the live options
   * object with the batcher, so `client.config.batch.maxQueue = 0` silently made
   * every subsequent event look queue-full.
   */
  get config(): Readonly<ResolvedConfig> {
    const batch = this.#resolved.batch;
    return Object.freeze({
      ...this.#resolved,
      batch: batch === false ? false : Object.freeze({ ...batch }),
    });
  }

  // ---- lifecycle ----

  /** Events still buffered. Always 0 unless batching is enabled. */
  get buffered(): number {
    return this.#batcher?.size ?? 0;
  }

  /**
   * Drains the buffer. A no-op when batching is off, so calling it
   * unconditionally in a shutdown hook is safe.
   */
  async flush(): Promise<void> {
    if (this.#batcher) {
      await this.#batcher.flush();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(
        'Intempt client is closed. Calls after close() are not sent; create a new client.',
      );
    }
  }

  /** Flushes, then releases timers and sockets. The client is unusable after. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#batcher) {
      await this.#batcher.close();
    }
    this.#closed = true;
    this.#transport.destroy();
  }
}

export const Intempt = {
  /** Creates a client. Nothing is sent until you call a method. */
  init(config: IntemptConfig): IntemptClient {
    return new IntemptClient(config);
  },
};
