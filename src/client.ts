import { mergeConfig, resolveConfig } from './config';
import { ApiKeyCredentials } from './credentials';
import { Transport } from './transport';
import { Batcher } from './batcher';
import type { FlushResult } from './batcher';
import type { DeliveryFailure } from './delivery';
import { Ingest } from './ingest';
import { Consent } from './consent';
import { Ecommerce } from './ecommerce';
import { Recommend } from './recommend';
import { Flags } from './flags';
import type { FlagContext, FlagDetail, VariationOptions } from './flags';
import type {
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
    const credentials = new ApiKeyCredentials(config.apiKey);
    this.#transport = new Transport(this.#resolved, credentials);

    const configRef = (): ResolvedConfig => this.#resolved;
    // Two distinct conditions, deliberately not folded together: opting out is a
    // silent no-op by design, while using a closed client is a programming error
    // and must be loud.
    const isOptedIn = (): boolean => this.#optedIn && !this.#closed;
    const assertOpen = (): void => this.#assertOpen();
    const report = (failure: DeliveryFailure): void => this.#reportFailure(failure);

    this.#ingest = new Ingest({
      transport: this.#transport,
      config: configRef,
      batcher: () => this.#batcher,
      isOptedIn,
      assertOpen,
      report,
    });

    if (this.#resolved.batch !== false) {
      this.#batcher = new Batcher({
        options: this.#resolved.batch,
        maxRequestEvents: this.#resolved.maxRequestEvents,
        logger: this.#resolved.logger,
        send: (events, deadline) => this.#ingest.send(events, deadline),
        report,
      });
    }

    this.consent = new Consent({
      transport: this.#transport,
      config: configRef,
      assertOpen,
      report,
    });
    this.ecommerce = new Ecommerce(this.#ingest);
    this.#recommend = new Recommend({ transport: this.#transport, config: configRef });
    this.#flags = new Flags({
      transport: this.#transport,
      config: configRef,
      keyPrefix: credentials.prefix,
    });
  }

  // ---- ingest, lifted to the top level so the common calls stay short ----
  //
  // Each resolves whether the event was accepted - queued in batch mode, delivered in direct
  // mode - and never rejects for a delivery problem (INT-7444); those reach `onDeliveryFailure`.
  // A Promise rather than the contract's synchronous bool: these were `Promise<void>`, and a
  // synchronous return would break every caller chaining `.then()`/`.catch()` on them.

  track(event: string, options: TrackOptions): Promise<boolean> {
    return this.#ingest.track(event, options);
  }

  trackBatch(events: TrackEvent[]): Promise<boolean> {
    return this.#ingest.trackBatch(events);
  }

  identify(options: IdentifyOptions): Promise<boolean> {
    return this.#ingest.identify(options);
  }

  group(options: GroupOptions): Promise<boolean> {
    return this.#ingest.group(options);
  }

  #reportFailure(failure: DeliveryFailure): void {
    const listener = this.#resolved.onDeliveryFailure;
    if (!listener) return;
    try {
      listener(failure);
    } catch (error) {
      this.#resolved.logger.error('[intempt] onDeliveryFailure listener threw', error);
    }
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
  async variation<T>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    this.#assertOpen();
    return this.#flags.value<T>(key, context, defaultValue, options);
  }

  /**
   * The value plus why it was returned (INT-7454). `reason` is `'error'`, with `error` set, when the
   * read failed and `defaultValue` came back; otherwise it is `'off'` whether or not a value was
   * served, because the platform sends no reason to tell "off" from "not targeted" (INT-7457).
   */
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
    const value = await this.variation<unknown>(key, context, defaultValue, options);
    // A served value of the wrong type is a misconfiguration, not something to coerce: `!!"false"`
    // is true, and a silent coercion would be indistinguishable from a correct answer.
    return typeof value === 'boolean' ? value : defaultValue;
  }

  async stringVariation(
    key: string,
    context: FlagContext,
    defaultValue: string,
    options?: VariationOptions,
  ): Promise<string> {
    const value = await this.variation<unknown>(key, context, defaultValue, options);
    return typeof value === 'string' ? value : defaultValue;
  }

  async numberVariation(
    key: string,
    context: FlagContext,
    defaultValue: number,
    options?: VariationOptions,
  ): Promise<number> {
    const value = await this.variation<unknown>(key, context, defaultValue, options);
    return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  }

  async jsonVariation<T extends object>(
    key: string,
    context: FlagContext,
    defaultValue: T,
    options?: VariationOptions,
  ): Promise<T> {
    const value = await this.variation<unknown>(key, context, defaultValue, options);
    return value !== null && typeof value === 'object' ? (value as T) : defaultValue;
  }

  /**
   * Every key assigned to this person, in one call.
   *
   * ⚠ **Not for a request path.** It names no keys, so the service evaluates every experience the
   * person is eligible for — and on this endpoint an evaluation is an **exposure**. That inflates
   * the denominator of every running server experiment with people who saw nothing, and spends the
   * `once` display budget for keys nobody rendered, after which `variation()` on those keys returns
   * your default forever. Two keys on a request path is two `variation()` calls, not one
   * `allFlags()`. Use this to enumerate: a debug endpoint, an admin view, a one-off audit.
   *
   * It sends `exposure: false` (INT-7456), which takes effect once audience-service honours the
   * field; until then the service ignores it and the costs above still apply.
   *
   * See `docs/CONVENTIONS.md` for the full trace and the platform change that would make it safe.
   */
  async allFlags(context: FlagContext): Promise<Record<string, unknown>> {
    this.#assertOpen();
    return this.#flags.all(context);
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
   * Re-enables sending. Note this gates every tracking write namespace; consent
   * is never gated (ruling D-5).
   */
  optIn(): void {
    this.#optedIn = true;
  }

  /**
   * Suppresses all outbound tracking writes: track, batch and commerce. Consent
   * is still sent, so a withdrawal reaches the server (ruling D-5).
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
        | 'org'
        | 'project'
        | 'apiKey'
        | 'sourceId'
        | 'batch'
        | 'keepAlive'
        | 'agent'
        | 'onDeliveryFailure'
      >
    > & { keepAlive?: never; agent?: never; onDeliveryFailure?: never },
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
   * Drains the buffer and resolves what it did: `{ sent, failed }` in events. Resolves
   * `{ sent: 0, failed: 0 }` when batching is off, so calling it unconditionally in a shutdown
   * hook is safe. Never rejects for a delivery problem.
   */
  async flush(): Promise<FlushResult> {
    if (this.#batcher) {
      return this.#batcher.flush();
    }
    return { sent: 0, failed: 0 };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(
        'Intempt client is closed. Calls after close() are not sent; create a new client.',
      );
    }
  }

  /**
   * Flushes, then releases timers and sockets, and resolves `{ sent, failed }` for the final
   * drain; events still unsent at the end count as failed. This is the contract's `shutdown()`
   * (CONTRACT-R2 §S2) under its existing name. The client is unusable after.
   */
  async close(): Promise<FlushResult> {
    if (this.#closed) return { sent: 0, failed: 0 };
    const result = this.#batcher ? await this.#batcher.close() : { sent: 0, failed: 0 };
    this.#closed = true;
    this.#transport.destroy();
    return result;
  }
}

export const Intempt = {
  /** Creates a client. Nothing is sent until you call a method. */
  init(config: IntemptConfig): IntemptClient {
    return new IntemptClient(config);
  },
};
