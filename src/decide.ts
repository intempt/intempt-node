import type { ExperiencesOptions, RecommendOptions, ResolvedConfig } from './types';
import { assertIdentifier, compact } from './utils';

/**
 * The API validates experience names and groups against this pattern
 * (ExperienceApiChooseRequest). Checking it here turns a server 400 into a
 * message that names the offending value.
 */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function assertNames(values: string[] | undefined, field: string): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) {
    throw new TypeError(`experiences: ${field} must be an array of strings`);
  }
  for (const value of values) {
    if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
      throw new TypeError(
        `experiences: ${field} entry ${JSON.stringify(value)} is invalid; ` +
          'the API allows only letters, digits, underscore and hyphen',
      );
    }
  }
}
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
  readonly #deps: DecideDeps;

  constructor(deps: DecideDeps) {
    this.#deps = deps;
  }

  /**
   * Resolves the variants this profile should see. One call covers both
   * experiments and personalizations via `type`.
   */
  async experiences(options: ExperiencesOptions): Promise<unknown[]> {
    if (options?.type !== 'experiment' && options?.type !== 'personalization') {
      throw new TypeError("experiences: type must be 'experiment' or 'personalization'");
    }
    assertIdentifier(options, 'experiences');
    // Both are optional and may be combined: the API marks only `identification`
    // as required, and accepts names and groups together. Verified live.
    assertNames(options.names, 'names');
    assertNames(options.groups, 'groups');

    const { sourceId } = this.#deps.config();
    const body = compact({
      identification: compact({
        userId: options.userId,
        accountId: options.accountId,
        // Only ever set by the deprecated 1.x shim.
        profileId: options.profileId,
        sourceId,
      }),
      groups: options.groups,
      names: options.names,
      optimizationType: options.type,
      device: options.device ?? 'all',
    });

    const response = await this.#deps.transport.post<ChooseResponse>(
      this.#deps.transport.projectPath('/optimization/choose-api'),
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

    const { sourceId } = this.#deps.config();
    const body = compact({
      userId: options.userId,
      accountId: options.accountId,
      // Only ever set by the deprecated 1.x shim.
      profileId: options.profileId,
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
