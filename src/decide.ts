import type {
  ExperiencesOptions,
  RecommendOptions,
  ResolvedConfig,
} from './types';
import { assertIdentifier, compact } from './utils';
import type { Transport } from './transport';

export interface DecideDeps {
  transport: Transport;
  config(): ResolvedConfig;
}

interface ChooseResponse {
  choices?: unknown[];
}

/**
 * Read-side decisioning. Both endpoints are scope-free on the server, so the
 * same public API key that ingests events can read decisions.
 */
export class Decide {
  constructor(private readonly deps: DecideDeps) {}

  /**
   * Resolves the variants this profile should see. One call covers both
   * experiments and personalizations via `type`.
   */
  async experiences(options: ExperiencesOptions): Promise<unknown[]> {
    if (options?.type !== 'experiment' && options?.type !== 'personalization') {
      throw new TypeError("experiences: type must be 'experiment' or 'personalization'");
    }
    assertIdentifier(options, 'experiences');
    if (options.groups && options.names) {
      throw new TypeError('experiences: pass groups or names, not both');
    }

    const { sourceId } = this.deps.config();
    const body = compact({
      identification: compact({
        profileId: options.profileId ?? options.userId,
        userId: options.userId,
        accountId: options.accountId,
        sourceId,
      }),
      groups: options.groups,
      names: options.names,
      optimizationType: options.type,
      device: options.device ?? 'all',
    });

    const response = await this.deps.transport.post<ChooseResponse>(
      this.deps.transport.projectPath('/optimization/choose-api'),
      body,
    );
    return response.body?.choices ?? [];
  }

  /** Reads a recommendation feed for this profile. */
  async recommend(options: RecommendOptions): Promise<unknown> {
    if (!options?.feedId) {
      throw new TypeError('recommend: feedId is required');
    }
    if (!Array.isArray(options.fields) || options.fields.length === 0) {
      throw new TypeError('recommend: fields must be a non-empty array');
    }
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new TypeError('recommend: limit must be a positive integer');
    }
    assertIdentifier(options, 'recommend');

    const { sourceId } = this.deps.config();
    const body = compact({
      profileId: options.profileId ?? options.userId,
      userId: options.userId,
      accountId: options.accountId,
      sourceId,
      fields: options.fields,
      limit: options.limit,
      productId: options.productId,
    });

    const response = await this.deps.transport.post(
      this.deps.transport.projectPath(`/feeds/${encodeURIComponent(options.feedId)}/data`),
      body,
    );
    return response.body;
  }
}
