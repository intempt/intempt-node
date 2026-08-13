import { IntemptClient } from './client';
import type { Logger, ProductLine } from './types';

/**
 * 1.x compatibility shim.
 *
 * Every method forwards to the 2.x client. Two behaviours deliberately differ
 * and are breaking:
 *
 *  - `trackingClient` / `consentsClient` / `optimizationClient` /
 *    `recommendationClient` are gone. They were never part of the documented
 *    surface but were reachable.
 *  - invalid arguments now reject instead of logging a warning and resolving.
 *    Silently swallowing a bad call is how events went missing unnoticed.
 *
 * Deprecated. Use `Intempt.init()`.
 */
/**
 * Attaches the 1.x `profileId` to a v2 options object.
 *
 * `profileId` is deliberately absent from the public option types, so this is the
 * one place the 1.x surface bridges to them. The field is still honoured
 * internally — see the `Internal*Options` intersections in ingest.ts — so the
 * value reaches the wire; only the static type needs widening, and confining that
 * to a single helper keeps it out of the public API.
 */
function withProfileId<T extends object>(profileId: string, options: T): T {
  return { ...options, profileId } as T;
}

export class SDK {
  readonly #client: IntemptClient;
  static #warned = false;

  constructor(
    orgName: string,
    projectName: string,
    apiKey: string,
    sourceId: string,
    time?: number,
    maxSize?: number,
  ) {
    if (!(orgName && projectName && apiKey && sourceId)) {
      throw new Error('Incorrect configuration parameters');
    }

    const batch =
      time === undefined && maxSize === undefined
        ? (false as const)
        : {
            ...(maxSize !== undefined ? { size: maxSize } : {}),
            ...(time !== undefined ? { flushMs: time } : {}),
          };

    this.#client = new IntemptClient({
      org: orgName,
      project: projectName,
      apiKey,
      sourceId,
      batch,
    });

    SDK.#warnOnce(this.#client.config.logger);
  }

  static #warnOnce(logger: Logger): void {
    if (SDK.#warned) return;
    SDK.#warned = true;
    logger.warn(
      '[intempt] `new SDK(...)` is deprecated and will be removed in 3.0.0. ' +
        'Use `Intempt.init({ org, project, apiKey, sourceId })`.',
    );
  }

  /** Escape hatch to the 2.x client while migrating. */
  get v2(): IntemptClient {
    return this.#client;
  }

  async identify(
    profileId: string,
    userId: string,
    eventTitle?: string,
    userAttributes?: object,
  ): Promise<void> {
    await this.#client.identify(
      withProfileId(profileId, {
        userId,
        ...(eventTitle ? { event: eventTitle } : {}),
        ...(userAttributes ? { traits: userAttributes as Record<string, unknown> } : {}),
      }),
    );
  }

  async group(
    profileId: string,
    accountId: string,
    eventTitle?: string,
    accountAttributes?: object,
  ): Promise<void> {
    await this.#client.group(
      withProfileId(profileId, {
        accountId,
        ...(eventTitle ? { event: eventTitle } : {}),
        ...(accountAttributes
          ? { attributes: accountAttributes as Record<string, unknown> }
          : {}),
      }),
    );
  }

  async track(profileId: string, eventTitle: string, data: object): Promise<void> {
    await this.#client.track(
      eventTitle,
      withProfileId(profileId, { properties: data as Record<string, unknown> }),
    );
  }

  async record(
    profileId: string,
    eventTitle: string,
    userId?: string,
    accountId?: string,
    data?: object,
    userAttributes?: object,
    accountAttributes?: object,
  ): Promise<void> {
    await this.#client.track(
      eventTitle,
      withProfileId(profileId, {
        ...(userId ? { userId } : {}),
        ...(accountId ? { accountId } : {}),
        ...(data ? { properties: data as Record<string, unknown> } : {}),
        ...(userAttributes
          ? { userAttributes: userAttributes as Record<string, unknown> }
          : {}),
        ...(accountAttributes
          ? { accountAttributes: accountAttributes as Record<string, unknown> }
          : {}),
      }),
    );
  }

  async alias(profileId: string, userId: string, anotherUserId: string): Promise<void> {
    await this.#client.alias(
      withProfileId(profileId, { userId, previousUserId: anotherUserId }),
    );
  }

  async consents(
    profileId: string,
    action: string,
    consentsExpirationTime?: string,
    email?: string,
    message?: string,
  ): Promise<void> {
    await this.consent(
      profileId,
      action,
      undefined,
      consentsExpirationTime,
      email,
      message,
    );
  }

  async consent(
    profileId: string,
    action: string,
    category?: string,
    consentsExpirationTime?: string,
    email?: string,
    message?: string,
  ): Promise<void> {
    if (action !== 'accept' && action !== 'reject') {
      throw new TypeError("consent: action must be 'accept' or 'reject'");
    }
    const options = {
      profileId,
      ...(category ? { category } : {}),
      ...(consentsExpirationTime ? { validUntil: consentsExpirationTime } : {}),
      ...(email ? { email } : {}),
      ...(message ? { message } : {}),
    };
    await (action === 'accept'
      ? this.#client.consent.grant(options)
      : this.#client.consent.revoke(options));
  }

  async productAdd(
    profileId: string,
    productId: string,
    quantity: number,
  ): Promise<void> {
    await this.#client.ecommerce.addedToCart(
      withProfileId(profileId, { productId, quantity }),
    );
  }

  async productView(profileId: string, productId: string): Promise<void> {
    await this.#client.ecommerce.productViewed(withProfileId(profileId, { productId }));
  }

  async productOrdered(profileId: string, products: ProductLine[]): Promise<void> {
    await this.#client.ecommerce.ordered(withProfileId(profileId, { products }));
  }

  async recommendation(
    profileId: string,
    id: string,
    quantity: number,
    fields: string[],
    productId?: string,
  ): Promise<unknown> {
    // 1.x passed a profileId, which the feeds API never read: it resolves an
    // {id, type} pair. Mapped to a user lookup.
    return this.#client.recommend({
      userId: profileId,
      feedId: id,
      limit: quantity,
      fields,
      ...(productId !== undefined ? { productId: String(productId) } : {}),
    });
  }

  /**
   * Experiments and personalizations resolve a web experience against a page and
   * are served by the browser SDK. A server has no page to modify, so these four
   * 1.x helpers cannot be honoured. They throw rather than returning an empty
   * array: [] would read as "no variant assigned" and quietly disable a caller's
   * experiment instead of telling them it moved.
   */
  static #experiencesRemoved(method: string): never {
    throw new Error(
      `${method} is not available in a server SDK. Experiments and ` +
        'personalizations are resolved per page by the browser SDK. ' +
        'See https://github.com/intempt/intempt-js',
    );
  }

  choosePersonalizationsByGroups(): Promise<never> {
    return SDK.#experiencesRemoved('choosePersonalizationsByGroups');
  }

  choosePersonalizationsByNames(): Promise<never> {
    return SDK.#experiencesRemoved('choosePersonalizationsByNames');
  }

  chooseExperimentsByGroups(): Promise<never> {
    return SDK.#experiencesRemoved('chooseExperimentsByGroups');
  }

  chooseExperimentsByNames(): Promise<never> {
    return SDK.#experiencesRemoved('chooseExperimentsByNames');
  }

  optIn(): void {
    this.#client.optIn();
  }

  optOut(): void {
    this.#client.optOut();
  }

  flush(): Promise<void> {
    return this.#client.flush();
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}
