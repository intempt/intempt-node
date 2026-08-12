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
import { assertIdentifier, chunk, compact, ensureTimestamp } from './utils';
import { stampPayload } from './stamp';
import type { Transport } from './transport';
import type { Batcher } from './batcher';

/** Reserved event name the platform interprets as an identity write. */
export const IDENTIFY_EVENT = 'Identify';

export interface IngestDeps {
  transport: Transport;
  config(): ResolvedConfig;
  batcher(): Batcher | undefined;
  isOptedIn(): boolean;
}

export class Ingest {
  constructor(private readonly deps: IngestDeps) {}

  /** `/sources/{id}/track` when a sourceId is configured, else `/track`. */
  private trackPath(): string {
    const { sourceId } = this.deps.config();
    return sourceId
      ? this.deps.transport.projectPath(`/sources/${encodeURIComponent(sourceId)}/track`)
      : this.deps.transport.projectPath('/track');
  }

  private buildEvent(name: string, options: TrackOptions): WireEvent {
    const item: WirePayloadItem = compact({
      eventId: randomUUID(),
      timestamp: options.timestamp === undefined ? Date.now() : ensureTimestamp(options.timestamp),
      profileId: options.profileId,
      userId: options.userId,
      accountId: options.accountId,
      data: options.properties,
      userAttributes: options.userAttributes,
      accountAttributes: options.accountAttributes,
    });

    return {
      name,
      payload: [stampPayload(item, this.deps.config().stampLibVersion)],
    };
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
    const stamp = this.deps.config().stampLibVersion;

    const event: WireEvent = {
      name,
      payload: lines.map((line) =>
        stampPayload(
          compact({
            eventId,
            timestamp,
            profileId: options.profileId,
            userId: options.userId,
            accountId: options.accountId,
            data: line,
          }),
          stamp,
        ),
      ),
    };

    await this.submit([event]);
  }

  /** Sends immediately, or buffers when batching is enabled. */
  private async submit(events: WireEvent[]): Promise<void> {
    if (!this.deps.isOptedIn() || events.length === 0) {
      return;
    }

    const batcher = this.deps.batcher();
    if (batcher) {
      for (const event of events) {
        batcher.enqueue(event);
      }
      return;
    }

    await this.send(events);
  }

  /** Posts one request. Used directly by the batcher. */
  async send(events: WireEvent[]): Promise<void> {
    await this.deps.transport.post(this.trackPath(), { track: events });
  }

  async track(event: string, options: TrackOptions): Promise<void> {
    assertEventName(event, 'track');
    assertIdentifier(options, 'track');
    await this.submit([this.buildEvent(event, options)]);
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

    const wire = events.map(({ event, ...options }) => this.buildEvent(event, options));

    const batcher = this.deps.batcher();
    if (batcher || !this.deps.isOptedIn()) {
      await this.submit(wire);
      return;
    }

    for (const group of chunk(wire, this.deps.config().maxRequestEvents)) {
      await this.send(group);
    }
  }

  async identify(options: IdentifyOptions): Promise<void> {
    assertIdentifier(options, 'identify');
    const { traits, event, ...ids } = options;
    await this.submit([
      this.buildEvent(reservedName(event, 'identify'), {
        ...ids,
        ...(traits !== undefined ? { userAttributes: traits } : {}),
      }),
    ]);
  }

  async group(options: GroupOptions): Promise<void> {
    if (!options?.accountId) {
      throw new TypeError('group: accountId is required');
    }
    assertIdentifier(options, 'group');
    const { attributes, event, ...ids } = options;
    await this.submit([
      this.buildEvent(reservedName(event, 'group'), {
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
    if (!options?.userId || !options?.previousUserId) {
      throw new TypeError('alias: userId and previousUserId are required');
    }
    const { previousUserId, ...ids } = options;
    const event = this.buildEvent(IDENTIFY_EVENT, ids);
    const item = event.payload[0];
    if (item) {
      item.anotherUserId = previousUserId;
    }
    await this.submit([event]);
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
