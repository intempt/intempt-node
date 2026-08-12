import type { RecommendOptions, ResolvedConfig } from './types';
import { compact } from './utils';
import type { Transport } from './transport';

export interface RecommendDeps {
  transport: Transport;
  config(): ResolvedConfig;
}

/**
 * Product recommendations from a feed.
 *
 * The feeds API identifies an entity with an `{id, type}` pair, not with the
 * `userId` / `profileId` fields the tracking endpoints take. `FeedRequest` has no
 * such fields, so sending them is silently ignored: the request then fails with
 * "Name is null" because no entity could be resolved. 1.x sent that shape, which
 * is why server-side recommendations never worked.
 *
 * This maps `userId` -> `{id: userId, type: 'user'}` and `accountId` ->
 * `{id: accountId, type: 'account'}` so the caller keeps working in the same two
 * identifiers as the rest of the SDK.
 */
export class Recommend {
  readonly #deps: RecommendDeps;

  constructor(deps: RecommendDeps) {
    this.#deps = deps;
  }

  async fetch(options: RecommendOptions): Promise<unknown> {
    if (!options?.feedId) {
      throw new TypeError('recommend: feedId is required');
    }
    if (!Array.isArray(options.fields) || options.fields.length === 0) {
      throw new TypeError('recommend: fields must be a non-empty array');
    }
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1)
    ) {
      throw new TypeError('recommend: limit must be a positive integer');
    }

    const { userId, accountId } = options;
    if (!userId && !accountId) {
      throw new TypeError('recommend: one of userId or accountId is required');
    }
    if (userId && accountId) {
      throw new TypeError(
        'recommend: pass userId or accountId, not both — the feeds API resolves a single entity',
      );
    }

    const { sourceId } = this.#deps.config();
    const body = compact({
      id: userId ?? accountId,
      type: userId ? 'user' : 'account',
      sourceId,
      fields: options.fields,
      limit: options.limit,
      productId: options.productId,
    });

    const response = await this.#deps.transport.post(
      this.#deps.transport.projectPath(
        `/feeds/${encodeURIComponent(options.feedId)}/data`,
      ),
      body,
    );
    return response.body;
  }
}
