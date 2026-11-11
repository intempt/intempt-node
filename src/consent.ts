import type { ConsentOptions, ResolvedConfig } from './types';

/** @internal — the 1.x shim identifies by profileId. */
type InternalConsentOptions = Omit<ConsentOptions, 'profileId'> & { profileId?: string };
import { compact, ensureTimestamp } from './utils';
import type { Transport } from './transport';
import { deliver } from './delivery';
import type { DeliveryFailure } from './delivery';

export const LIB_SOURCE = 'NodeJs tracker';

/**
 * Lowest timestamp the server accepts, mirrored from
 * push-source-service DataUtils.LOW_TIMESTAMP_LIMIT (2010-01-01, in ms).
 */
const LOW_TIMESTAMP_LIMIT_MS = 1_262_304_000_000;

export interface ConsentDeps {
  transport: Transport;
  config(): ResolvedConfig;
  /** Throws if the client has been closed. */
  assertOpen(): void;
  report(failure: DeliveryFailure): void;
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
    const blank = (v: string | undefined): boolean =>
      v === undefined || typeof v !== 'string' || v.trim() === '';
    if (blank(userId) && blank(profileId)) {
      throw new TypeError('consent: userId must be a non-empty string');
    }

    const { sourceId } = this.#deps.config();
    // The server rejects a profileId-identified consent record without a source.
    if (profileId && !sourceId) {
      throw new TypeError(
        'consent: sourceId must be configured to record consent by profileId; ' +
          'pass userId instead, or set sourceId in Intempt.init',
      );
    }

    // Deliberately NOT gated on opt-out (ruling D-5, INT-7437): a withdrawal must reach the
    // server precisely when the person has opted out. intempt-js consent() does the same.
    this.#deps.assertOpen();

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

    // Same failure policy as tracking (CONTRACT-R2 §S1): sent once, never rejects for delivery.
    const path = this.#deps.transport.projectPath('/consents/data');
    const outcome = await deliver([], () => this.#deps.transport.post(path, body));
    if (!outcome.ok) {
      const { failure } = outcome;
      this.#deps.config().logger.error('[intempt] consent delivery failed', {
        kind: failure.kind,
        status: failure.status,
      });
      this.#deps.report({
        ...failure,
        ...(failure.kind === 'transport' ? { kind: 'dropped', terminal: true } : {}),
        eventCount: 1,
      });
    }
  }
}
