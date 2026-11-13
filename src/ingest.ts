import { randomUUID } from 'node:crypto';
import type {
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
import { deliver } from './delivery';
import type { DeliveryFailure, SendOutcome } from './delivery';

/**
 * The option shapes as seen from inside, where `profileId` is still a real field.
 *
 * The public types deliberately omit it. Only the deprecated 1.x shim supplies
 * one, and it does so through these intersections rather than by widening the
 * public types — which is what previously leaked `profileId` back onto the v2
 * surface. Same pattern as `InternalConsentOptions` in consent.ts.
 *
 * @internal
 */
type WithProfileId<T> = Omit<T, 'profileId'> & { profileId?: string };
type InternalTrackOptions = WithProfileId<TrackOptions>;
type InternalIdentifyOptions = WithProfileId<IdentifyOptions>;
type InternalGroupOptions = WithProfileId<GroupOptions>;

/** Reserved event name the platform interprets as an identity write. */
export const IDENTIFY_EVENT = 'Identify';

export interface IngestDeps {
  transport: Transport;
  config(): ResolvedConfig;
  batcher(): Batcher | undefined;
  isOptedIn(): boolean;
  /** Throws if the client has been closed. */
  assertOpen(): void;
  /** Final outcome of a write that did not deliver. */
  report(failure: DeliveryFailure): void;
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

  #buildEvent(name: string, options: InternalTrackOptions): WireEvent {
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
    options: InternalTrackOptions,
    lines: readonly Record<string, unknown>[],
  ): Promise<boolean> {
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

    return this.#submit([event]);
  }

  /**
   * Sends immediately, or buffers when batching is enabled. Resolves whether the events were
   * accepted: queued in batch mode, delivered in direct mode. Never rejects for delivery
   * (CONTRACT-R2 §S2).
   */
  async #submit(events: WireEvent[]): Promise<boolean> {
    // A closed client throws; an opted-out client returns quietly. Silently
    // discarding a write after close is how 1.x lost events without telling
    // anyone, and the README promises nothing is swallowed.
    this.#deps.assertOpen();
    if (!this.#deps.isOptedIn() || events.length === 0) {
      return false;
    }

    const batcher = this.#deps.batcher();
    if (batcher) {
      let accepted = true;
      for (const event of events) {
        accepted = batcher.enqueue(event) && accepted;
      }
      return accepted;
    }

    return this.#sendDirect(events);
  }

  /** Direct mode has no queue, so a never-reached request is dropped, not kept (S1.5). */
  async #sendDirect(events: WireEvent[]): Promise<boolean> {
    const outcome = await this.send(events);
    if (outcome.ok) return true;
    const { failure } = outcome;
    this.#deps.config().logger.error('[intempt] delivery failed; events dropped', {
      kind: failure.kind,
      status: failure.status,
      count: events.length,
    });
    this.#deps.report(
      failure.kind === 'transport'
        ? { ...failure, kind: 'dropped', terminal: true }
        : failure,
    );
    return false;
  }

  /**
   * Posts one request. Also the batcher's send callback, which is why the opt-out
   * gate is repeated here: the batcher calls this directly, bypassing `#submit`.
   * Without it, events captured before `optOut()` were still transmitted by a
   * later `flush()`, `close()` or the exit hook — a consent revocation between
   * capture and flush would not have been honoured.
   */
  async send(events: WireEvent[], deadline?: number): Promise<SendOutcome> {
    if (!this.#deps.isOptedIn()) {
      this.#deps
        .config()
        .logger.warn(
          `[intempt] opted out; discarding ${events.length} buffered event(s) rather than sending`,
        );
      return { ok: true };
    }
    const path = this.#trackPath();
    return deliver(
      events,
      () => this.#deps.transport.post(path, { track: events }),
      deadline !== undefined ? { deadline } : {},
    );
  }

  async track(event: string, options: InternalTrackOptions): Promise<boolean> {
    assertEventName(event, 'track');
    assertIdentifier(options, 'track');
    return this.#submit([this.#buildEvent(event, options)]);
  }

  /**
   * Sends many events. Chunked so one oversized call cannot become one
   * oversized request; the server's per-request ceiling is not published, so
   * the chunk size comes from config. Each chunk is sent once (INT-7436): a
   * 413 drops and reports that chunk rather than halving and resending it.
   */
  async trackBatch(events: WithProfileId<TrackEvent>[]): Promise<boolean> {
    if (!Array.isArray(events)) {
      throw new TypeError('trackBatch: events must be an array');
    }
    if (events.length === 0) {
      return true;
    }
    events.forEach((event, index) => {
      assertEventName(event?.event, `trackBatch[${index}]`);
      assertIdentifier(event, `trackBatch[${index}]`);
    });

    const wire = events.map(({ event, ...options }) => this.#buildEvent(event, options));

    const batcher = this.#deps.batcher();
    if (batcher || !this.#deps.isOptedIn()) {
      return this.#submit(wire);
    }

    const { maxRequestEvents, maxConcurrentRequests } = this.#deps.config();
    const groups = chunk(wire, maxRequestEvents);
    let delivered = true;

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
          delivered = (await this.#sendDirect(group)) && delivered;
        }
      },
    );

    // allSettled, then rethrow the first failure: only a programming error (an
    // unserialisable payload) still rejects, and it must not leave sibling
    // requests unawaited and surfacing as unhandled rejections.
    const results = await Promise.allSettled(workers);
    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed) {
      throw failed.reason;
    }
    return delivered;
  }

  async identify(options: InternalIdentifyOptions): Promise<boolean> {
    assertIdentifier(options, 'identify');
    const { traits, event, ...ids } = options;
    return this.#submit([
      this.#buildEvent(reservedName(event, 'identify'), {
        ...ids,
        ...(traits !== undefined ? { userAttributes: traits } : {}),
      }),
    ]);
  }

  async group(options: InternalGroupOptions): Promise<boolean> {
    // No assertIdentifier here: accountId is required by the signature and is
    // itself an identifier, so the check can never fail. Mutation testing found
    // it — the string 'group' could be rewritten to anything and no test noticed,
    // because the line is unreachable.
    assertNonBlank(options?.accountId, 'group', 'accountId');
    const { attributes, event, ...ids } = options;
    return this.#submit([
      this.#buildEvent(reservedName(event, 'group'), {
        ...ids,
        ...(attributes !== undefined ? { accountAttributes: attributes } : {}),
      }),
    ]);
  }
}

function assertEventName(event: unknown, method: string): void {
  if (typeof event !== 'string' || event.trim() === '') {
    throw new TypeError(`${method}: event name is required`);
  }
  if (event === IDENTIFY_EVENT) {
    throw new TypeError(
      `${method}: "${IDENTIFY_EVENT}" is reserved; use identify() or group()`,
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
