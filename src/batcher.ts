/**
 * Opt-in event buffer for long-lived processes.
 *
 * Not inherited from the browser SDK: that queue is built around localStorage,
 * cross-tab locks and page-unload semantics, none of which exist here. What is
 * carried over is the retry policy, expressed below as a plain decision table.
 *
 * Deliberately in-memory. Crash durability needs disk with fsync, file locking
 * and boot-time recovery, which is a different design and is not in scope.
 */

import type { Logger, ResolvedBatchOptions, WireEvent } from './types';
import { IntemptApiError } from './transport';

const MAX_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;

export interface BatcherOptions {
  options: ResolvedBatchOptions;
  /** Hard ceiling on events per request; caps the flush width. */
  maxRequestEvents: number;
  logger: Logger;
  /** Sends one chunk. Rejects with `IntemptApiError` on failure. */
  send(events: WireEvent[]): Promise<unknown>;
}

export class Batcher {
  private readonly options: ResolvedBatchOptions;
  private readonly maxRequestEvents: number;
  private readonly logger: Logger;
  private readonly send: (events: WireEvent[]) => Promise<unknown>;

  private queue: WireEvent[] = [];
  private batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  /** Serialises flushes so two callers can never drain the same slice. */
  private chain: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;
  private stopped = false;
  private exitHook: (() => void) | undefined;

  constructor({ options, maxRequestEvents, logger, send }: BatcherOptions) {
    this.options = options;
    this.maxRequestEvents = maxRequestEvents;
    this.logger = logger;
    this.send = send;
    this.batchSize = Math.min(options.size, maxRequestEvents);

    if (options.flushOnExit) {
      this.exitHook = () => {
        void this.flush();
      };
      process.on('beforeExit', this.exitHook);
    }
  }

  /** Buffers an event. Returns false when the event was dropped. */
  enqueue(event: WireEvent): boolean {
    if (this.stopped) {
      this.logger.error('[intempt] batching is stopped; event dropped', { name: event.name });
      return false;
    }
    if (this.queue.length >= this.options.maxQueue) {
      this.logger.error('[intempt] batch queue full; event dropped', {
        name: event.name,
        maxQueue: this.options.maxQueue,
      });
      return false;
    }

    this.queue.push(event);

    if (this.queue.length >= this.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush(this.options.flushMs);
    }
    return true;
  }

  /**
   * Drains the queue. Awaiting this resolves only once the queue is empty or
   * the batcher has stopped, so `close()` cannot return with events buffered.
   */
  async flush(): Promise<void> {
    const next = this.chain.then(() => this.drain());
    // Keep the chain itself settled so one failure cannot poison later flushes.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async drain(): Promise<void> {
    this.clearTimer();

    while (this.queue.length > 0 && !this.stopped) {
      // Take a slice rather than the whole array: events appended during the
      // await stay queued instead of being cleared out from under the send.
      const batch = this.queue.slice(0, this.batchSize);

      try {
        await this.send(batch);
      } catch (error) {
        const handled = await this.handleFailure(error, batch);
        if (handled === 'requeue') continue;
        if (handled === 'stop') return;
      }

      this.queue.splice(0, batch.length);
      this.consecutiveFailures = 0;
      this.batchSize = Math.min(this.options.size, this.maxRequestEvents);
    }
  }

  /**
   * 413 (batch > 1)  halve the batch size and retry
   * 413 (batch = 1)  drop the event, log the drop
   * 429              honour Retry-After, else exponential backoff
   * 5xx / 408        exponential backoff
   * timeout          exponential backoff
   * other 4xx        drop the batch, surface the error
   */
  private async handleFailure(
    error: unknown,
    batch: WireEvent[],
  ): Promise<'requeue' | 'stop'> {
    const apiError = error instanceof IntemptApiError ? error : undefined;
    const status = apiError?.status;

    if (status === 413) {
      if (batch.length > 1) {
        this.batchSize = Math.max(1, Math.floor(batch.length / 2));
        this.logger.warn(`[intempt] 413 received; reducing batch size to ${this.batchSize}`);
        return 'requeue';
      }
      this.logger.error('[intempt] single event too large; dropping', {
        name: batch[0]?.name,
      });
      this.queue.splice(0, 1);
      this.batchSize = Math.min(this.options.size, this.maxRequestEvents);
      return 'requeue';
    }

    if (apiError && !apiError.retryable) {
      this.logger.error('[intempt] non-retryable error; dropping batch', {
        status,
        body: apiError.body,
        count: batch.length,
      });
      this.queue.splice(0, batch.length);
      return 'requeue';
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.logger.error(
        `[intempt] ${this.consecutiveFailures} consecutive failures; stopping batching. ` +
          `${this.queue.length} event(s) remain buffered.`,
        error,
      );
      this.stopped = true;
      return 'stop';
    }

    const backoff = Math.min(
      MAX_RETRY_INTERVAL_MS,
      apiError?.retryAfterMs ?? this.options.flushMs * 2 ** this.consecutiveFailures,
    );
    this.logger.warn(`[intempt] send failed; retrying in ${backoff}ms`, error);
    await delay(backoff);
    return 'requeue';
  }

  private scheduleFlush(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
    // Never hold the event loop open just to wait for a flush.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Number of events still buffered. */
  get size(): number {
    return this.queue.length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async close(): Promise<void> {
    await this.flush();
    this.stopped = true;
    this.clearTimer();
    if (this.exitHook) {
      process.removeListener('beforeExit', this.exitHook);
      this.exitHook = undefined;
    }
  }
}

// Not unref'd: a retry is work in progress, and abandoning it at exit would
// silently lose the batch. Backoff is bounded by MAX_CONSECUTIVE_FAILURES.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
