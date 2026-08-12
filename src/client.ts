import { mergeConfig, resolveConfig } from './config';
import { ApiKeyCredentials } from './credentials';
import { Transport } from './transport';
import { Batcher } from './batcher';
import { Ingest } from './ingest';
import { Consent } from './consent';
import { Ecommerce } from './ecommerce';
import { Decide } from './decide';
import type {
  AliasOptions,
  GroupOptions,
  IdentifyOptions,
  IntemptConfig,
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
  readonly decide: Decide;

  constructor(config: IntemptConfig) {
    this.#resolved = resolveConfig(config);
    this.#transport = new Transport(this.#resolved, new ApiKeyCredentials(config.apiKey));

    const configRef = (): ResolvedConfig => this.#resolved;
    const isOptedIn = (): boolean => this.#optedIn && !this.#closed;

    this.#ingest = new Ingest({
      transport: this.#transport,
      config: configRef,
      batcher: () => this.#batcher,
      isOptedIn,
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
    });
    this.ecommerce = new Ecommerce(this.#ingest);
    this.decide = new Decide({ transport: this.#transport, config: configRef });
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
   * Read-side `decide` calls are unaffected — they send an identifier the
   * caller already holds and return a decision rather than storing anything.
   */
  optOut(): void {
    this.#optedIn = false;
  }

  isOptedIn(): boolean {
    return this.#optedIn && !this.#closed;
  }

  // ---- config ----

  setConfig(
    patch: Partial<Omit<IntemptConfig, 'org' | 'project' | 'apiKey' | 'sourceId' | 'batch'>>,
  ): void {
    this.#resolved = mergeConfig(this.#resolved, patch);
    this.#transport.setConfig(this.#resolved);
  }

  /** A frozen snapshot. Mutating it would not change the client. */
  get config(): Readonly<ResolvedConfig> {
    return Object.freeze({ ...this.#resolved });
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
