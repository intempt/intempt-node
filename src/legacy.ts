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
    await this.#client.identify({
      profileId,
      userId,
      ...(eventTitle ? { event: eventTitle } : {}),
      ...(userAttributes ? { traits: userAttributes as Record<string, unknown> } : {}),
    });
  }

  async group(
    profileId: string,
    accountId: string,
    eventTitle?: string,
    accountAttributes?: object,
  ): Promise<void> {
    await this.#client.group({
      profileId,
      accountId,
      ...(eventTitle ? { event: eventTitle } : {}),
      ...(accountAttributes
        ? { attributes: accountAttributes as Record<string, unknown> }
        : {}),
    });
  }

  async track(profileId: string, eventTitle: string, data: object): Promise<void> {
    await this.#client.track(eventTitle, {
      profileId,
      properties: data as Record<string, unknown>,
    });
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
    await this.#client.track(eventTitle, {
      profileId,
      ...(userId ? { userId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(data ? { properties: data as Record<string, unknown> } : {}),
      ...(userAttributes ? { userAttributes: userAttributes as Record<string, unknown> } : {}),
      ...(accountAttributes
        ? { accountAttributes: accountAttributes as Record<string, unknown> }
        : {}),
    });
  }

  async alias(profileId: string, userId: string, anotherUserId: string): Promise<void> {
    await this.#client.alias({ profileId, userId, previousUserId: anotherUserId });
  }

  async consents(
    profileId: string,
    action: string,
    consentsExpirationTime?: string,
    email?: string,
    message?: string,
  ): Promise<void> {
    await this.consent(profileId, action, undefined, consentsExpirationTime, email, message);
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

  async productAdd(profileId: string, productId: string, quantity: number): Promise<void> {
    await this.#client.ecommerce.addedToCart({ profileId, productId, quantity });
  }

  async productView(profileId: string, productId: string): Promise<void> {
    await this.#client.ecommerce.productViewed({ profileId, productId });
  }

  async productOrdered(profileId: string, products: ProductLine[]): Promise<void> {
    await this.#client.ecommerce.ordered({ profileId, products });
  }

  async recommendation(
    profileId: string,
    id: string,
    quantity: number,
    fields: string[],
    productId?: string,
  ): Promise<unknown> {
    return this.#client.decide.recommend({
      profileId,
      feedId: id,
      limit: quantity,
      fields,
      ...(productId !== undefined ? { productId: String(productId) } : {}),
    });
  }

  choosePersonalizationsByGroups(profileId: string, groups?: string[]): Promise<unknown[]> {
    return this.#client.decide.experiences({
      profileId,
      type: 'personalization',
      ...(groups ? { groups } : {}),
    });
  }

  choosePersonalizationsByNames(profileId: string, names?: string[]): Promise<unknown[]> {
    return this.#client.decide.experiences({
      profileId,
      type: 'personalization',
      ...(names ? { names } : {}),
    });
  }

  chooseExperimentsByGroups(profileId: string, groups?: string[]): Promise<unknown[]> {
    return this.#client.decide.experiences({
      profileId,
      type: 'experiment',
      ...(groups ? { groups } : {}),
    });
  }

  chooseExperimentsByNames(profileId: string, names?: string[]): Promise<unknown[]> {
    return this.#client.decide.experiences({
      profileId,
      type: 'experiment',
      ...(names ? { names } : {}),
    });
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
