import type { ConsentOptions, ResolvedConfig } from './types';

/** @internal — the 1.x shim identifies by profileId. */
type InternalConsentOptions = ConsentOptions & { profileId?: string };
import { compact, ensureTimestamp } from './utils';
import type { Transport } from './transport';

export const LIB_SOURCE = 'NodeJs tracker';

/**
 * Lowest timestamp the server accepts, mirrored from
 * push-source-service DataUtils.LOW_TIMESTAMP_LIMIT (2010-01-01, in ms).
 */
const LOW_TIMESTAMP_LIMIT_MS = 1_262_304_000_000;

export interface ConsentDeps {
  transport: Transport;
  config(): ResolvedConfig;
  isOptedIn(): boolean;
}

export class Consent {
  readonly #deps: ConsentDeps;

  constructor(deps: ConsentDeps) {
    this.#deps = deps;
  }

  grant(options: ConsentOptions): Promise<void> {
    return this.#record('accept', options);
  }

  revoke(options: ConsentOptions): Promise<void> {
    return this.#record('reject', options);
  }

  async #record(
    action: 'accept' | 'reject',
    options: InternalConsentOptions,
  ): Promise<void> {
    if (!options || typeof options !== 'object') {
      throw new TypeError(
        `consent.${action === 'accept' ? 'grant' : 'revoke'}: options are required`,
      );
    }
    const { userId, profileId } = options;
    if (!userId && !profileId) {
      throw new TypeError('consent: userId is required');
    }

    const { sourceId } = this.#deps.config();
    // The server rejects a profileId-identified consent record without a source.
    if (profileId && !sourceId) {
      throw new TypeError(
        'consent: sourceId must be configured to record consent by profileId; ' +
          'pass userId or masterId instead, or set sourceId in Intempt.init',
      );
    }

    if (!this.#deps.isOptedIn()) {
      return;
    }

    const ms =
      options.timestamp === undefined ? Date.now() : ensureTimestamp(options.timestamp);
    if (ms < LOW_TIMESTAMP_LIMIT_MS) {
      throw new RangeError(
        `consent: timestamp is below the API threshold of ${LOW_TIMESTAMP_LIMIT_MS} (2010-01-01)`,
      );
    }

    const body = compact({
      action,
      // The API compares `timestamp * 1000` against millisecond bounds, so this
      // field is epoch SECONDS. Sending milliseconds makes the server discard
      // the value and substitute its own receive time.
      timestamp: Math.floor(ms / 1000),
      category: options.category,
      profileId,
      userId,
      // A string, never coerced with Number(). A real sourceId such as
      // 1841503112918048768 is 19 digits, well past Number.MAX_SAFE_INTEGER, so
      // Number() would silently round it to 1841503112918048800 and address the
      // wrong source. The API declares the field with LongFromStringDeserializer
      // for exactly this reason.
      sourceId: profileId && sourceId ? String(sourceId) : undefined,
      validUntil: options.validUntil ?? 'unlimited',
      source: LIB_SOURCE,
      email: options.email,
      message: options.message,
      reason: options.reason,
      method: options.method,
      deviceInfo: options.deviceInfo,
    });

    await this.#deps.transport.post(
      this.#deps.transport.projectPath('/consents/data'),
      body,
    );
  }
}
