import type { IntemptConfig } from './types';
import { resolveConfig } from './config';
import { ApiKeyCredentials } from './credentials';
import { IntemptApiError, Transport } from './transport';
import { Flags } from './flag-evaluator';
import type { FlagContext, FlagDetail, VariationOptions } from './flag-evaluator';

/**
 * The `intempt-nodejs-sdk/flags` entry (F33): the flag surface on its own transport, loading the
 * shared core and the evaluator only, never the batcher, ingest, delivery or consent.
 * tests/flags-standalone.test.ts runs the built entry with every tracking module deleted, and pins
 * its export list.
 */

export type {
  FlagContext,
  FlagDetail,
  FlagError,
  FlagErrorCode,
  FlagErrorKind,
  FlagReason,
  VariationOptions,
} from './flag-evaluator';
export { IntemptApiError };

/** Config for the flags-only client: the shared core, without the tracking options. */
export type IntemptFlagsConfig = Omit<
  IntemptConfig,
  'batch' | 'maxRequestEvents' | 'maxConcurrentRequests' | 'onDeliveryFailure'
>;

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
    this.#flags.close();
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
