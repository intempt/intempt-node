import { randomUUID } from 'node:crypto';
import type {
  AliasOptions,
  GroupOptions,
  IdentifyOptions,
  ResolvedConfig,
  TrackEvent,
  TrackOptions,
  WireEvent,
  WirePayloadItem,
} from './types';
import {
  assertIdentifier,
  assertNonBlank,
  chunk,
  compact,
  ensureTimestamp,
} from './utils';
import type { Transport } from './transport';
import type { Batcher } from './batcher';

/** Reserved event name the platform interprets as an identity write. */
export const IDENTIFY_EVENT = 'Identify';

export interface IngestDeps {
  transport: Transport;
  config(): ResolvedConfig;
  batcher(): Batcher | undefined;
  isOptedIn(): boolean;
  /** Throws if the client has been closed. */
  assertOpen(): void;
}

export class Ingest {
  readonly #deps: IngestDeps;

  constructor(deps: IngestDeps) {
    this.#deps = deps;
  }

  /** `/sources/{id}/track` when a sourceId is configured, else `/track`. */
  #trackPath(): string {
    const { sourceId } = this.#deps.config();
    return sourceId
      ? this.#deps.transport.projectPath(`/sources/${encodeURIComponent(sourceId)}/track`)
      : this.#deps.transport.projectPath('/track');
  }

  #buildEvent(name: string, options: TrackOptions): WireEvent {
    const item: WirePayloadItem = compact({
      eventId: randomUUID(),
      timestamp:
        options.timestamp === undefined ? Date.now() : ensureTimestamp(options.timestamp),
      profileId: options.profileId,
      userId: options.userId,
      accountId: options.accountId,
      data: options.properties,
      userAttributes: options.userAttributes,
      accountAttributes: options.accountAttributes,
    });

    return { name, payload: [item] };
  }

  /**
   * One event carrying several payload items, one per line.
   *
   * Kept bit-compatible with the 1.x commerce wire format: the lines share a
   * single `eventId`, exactly as `TrackingClient.productTrack` did. That is odd
   * — per-item dedup cannot distinguish the lines — but changing it would
   * change ingestion semantics, which is not an SDK decision. Raised in the PR.
   */
  async trackLines(
    name: string,
    options: TrackOptions,
    lines: readonly Record<string, unknown>[],
  ): Promise<void> {
    const eventId = randomUUID();
    const timestamp =
      options.timestamp === undefined ? Date.now() : ensureTimestamp(options.timestamp);
    const event: WireEvent = {
      name,
      payload: lines.map((line) =>
        compact({
          eventId,
          timestamp,
          profileId: options.profileId,
          userId: options.userId,
          accountId: options.accountId,
          data: line,
        }),
      ),
    };

    await this.#submit([event]);
  }

  /** Sends immediately, or buffers when batching is enabled. */
  async #submit(events: WireEvent[]): Promise<void> {
    // A closed client throws; an opted-out client returns quietly. Silently
    // discarding a write after close is how 1.x lost events without telling
    // anyone, and the README promises nothing is swallowed.
    this.#deps.assertOpen();
    if (!this.#deps.isOptedIn() || events.length === 0) {
      return;
    }

    const batcher = this.#deps.batcher();
    if (batcher) {
      for (const event of events) {
        batcher.enqueue(event);
      }
      return;
    }

    await this.send(events);
  }

  /**
   * Posts one request. Also the batcher's send callback, which is why the opt-out
   * gate is repeated here: the batcher calls this directly, bypassing `#submit`.
   * Without it, events captured before `optOut()` were still transmitted by a
   * later `flush()`, `close()` or the exit hook — a consent revocation between
   * capture and flush would not have been honoured.
   */
  async send(events: WireEvent[]): Promise<void> {
    if (!this.#deps.isOptedIn()) {
      this.#deps
        .config()
        .logger.warn(
          `[intempt] opted out; discarding ${events.length} buffered event(s) rather than sending`,
        );
      return;
    }
    await this.#deps.transport.post(this.#trackPath(), { track: events });
  }

  async track(event: string, options: TrackOptions): Promise<void> {
    assertEventName(event, 'track');
    assertIdentifier(options, 'track');
    await this.#submit([this.#buildEvent(event, options)]);
  }

  /**
   * Sends many events. Chunked so one oversized call cannot become one
   * oversized request; the server's per-request ceiling is not published, so
   * the chunk size comes from config and 413s halve it at runtime.
   */
  async trackBatch(events: TrackEvent[]): Promise<void> {
    if (!Array.isArray(events)) {
      throw new TypeError('trackBatch: events must be an array');
    }
    if (events.length === 0) {
      return;
    }
    events.forEach((event, index) => {
      assertEventName(event?.event, `trackBatch[${index}]`);
      assertIdentifier(event, `trackBatch[${index}]`);
    });

    const wire = events.map(({ event, ...options }) => this.#buildEvent(event, options));

    const batcher = this.#deps.batcher();
    if (batcher || !this.#deps.isOptedIn()) {
      await this.#submit(wire);
      return;
    }

    const { maxRequestEvents, maxConcurrentRequests } = this.#deps.config();
    const groups = chunk(wire, maxRequestEvents);

    if (maxConcurrentRequests <= 1) {
      for (const group of groups) {
        await this.send(group);
      }
      return;
    }

    // Bounded parallelism: workers pull from a shared cursor, so a slow request
    // does not stall the others and no more than maxConcurrentRequests are ever
    // in flight. Adapted from mixpanel-node's max_concurrent_requests, minus its
    // wave-at-a-time barrier.
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(maxConcurrentRequests, groups.length) },
      async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const group = groups[index];
          if (group === undefined) return;
          await this.send(group);
        }
      },
    );

    // allSettled, then rethrow the first failure: a rejection must not leave
    // sibling requests unawaited and surfacing as unhandled rejections.
    const results = await Promise.allSettled(workers);
    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed) {
      throw failed.reason;
    }
  }

  async identify(options: IdentifyOptions): Promise<void> {
    assertIdentifier(options, 'identify');
    const { traits, event, ...ids } = options;
    await this.#submit([
      this.#buildEvent(reservedName(event, 'identify'), {
        ...ids,
        ...(traits !== undefined ? { userAttributes: traits } : {}),
      }),
    ]);
  }

  async group(options: GroupOptions): Promise<void> {
    // No assertIdentifier here: accountId is required by the signature and is
    // itself an identifier, so the check can never fail. Mutation testing found
    // it — the string 'group' could be rewritten to anything and no test noticed,
    // because the line is unreachable.
    assertNonBlank(options?.accountId, 'group', 'accountId');
    const { attributes, event, ...ids } = options;
    await this.#submit([
      this.#buildEvent(reservedName(event, 'group'), {
        ...ids,
        ...(attributes !== undefined ? { accountAttributes: attributes } : {}),
      }),
    ]);
  }

  /**
   * Declares two user identities as the same person and lets the platform
   * resolve them. This is the supported path; the destructive
   * `/users/merge` endpoint is deliberately not exposed here.
   */
  async alias(options: AliasOptions): Promise<void> {
    assertNonBlank(options?.userId, 'alias', 'userId');
    assertNonBlank(options?.previousUserId, 'alias', 'previousUserId');
    const { previousUserId, ...ids } = options;
    const event = this.#buildEvent(IDENTIFY_EVENT, ids);
    const item = event.payload[0];
    if (item) {
      item.anotherUserId = previousUserId;
    }
    await this.#submit([event]);
  }
}

function assertEventName(event: unknown, method: string): void {
  if (typeof event !== 'string' || event.trim() === '') {
    throw new TypeError(`${method}: event name is required`);
  }
  if (event === IDENTIFY_EVENT) {
    throw new TypeError(
      `${method}: "${IDENTIFY_EVENT}" is reserved; use identify(), group() or alias()`,
    );
  }
}

function reservedName(event: string | undefined, method: string): string {
  if (event === undefined) {
    return IDENTIFY_EVENT;
  }
  if (typeof event !== 'string' || event.trim() === '') {
    throw new TypeError(`${method}: event must be a non-empty string when provided`);
  }
  return event;
}
