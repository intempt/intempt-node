/**
 * Opt-in event buffer for long-lived processes.
 *
 * Not inherited from the browser SDK: that queue is built around localStorage,
 * cross-tab locks and page-unload semantics, none of which exist here. The
 * failure policy lives in `delivery.ts` (INT-7436, CONTRACT-R2 §S1); this file
 * only decides what a failed batch means for the queue.
 *
 * Deliberately in-memory. Crash durability needs disk with fsync, file locking
 * and boot-time recovery, which is a different design and is not in scope.
 */

import type { Logger, ResolvedBatchOptions, WireEvent } from './types';
import type { DeliveryFailure, SendOutcome } from './delivery';
import { eventIdsOf } from './delivery';

/**
 * How long `close()` will keep draining before it gives up and says what it lost.
 *
 * A ceiling makes shutdown predictable. Events still buffered when it expires are
 * lost either way — the process is going down — so the thing that matters is that
 * the loss is counted and reported rather than silent.
 *
 * Only `close()` is bounded. A plain `flush()` sends each batch once (plus at most
 * one capped 429/503 resend), so it is bounded by the queue length already.
 */
const CLOSE_DRAIN_BUDGET_MS = 30_000;

/** What one `flush()` or `close()` did with the events it handled. */
export interface FlushResult {
  sent: number;
  failed: number;
}

export interface BatcherOptions {
  options: ResolvedBatchOptions;
  /**
   * Overrides CLOSE_DRAIN_BUDGET_MS. Internal, and not reachable from
   * `IntemptConfig` on purpose — it exists so tests can drive the deadline
   * without waiting 30 seconds of real time.
   *
   * @internal
   */
  closeBudgetMs?: number;
  /** Hard ceiling on events per request; caps the flush width. */
  maxRequestEvents: number;
  logger: Logger;
  /** Sends one chunk under the delivery policy. `deadline` is set during close. */
  send(events: WireEvent[], deadline: number | undefined): Promise<SendOutcome>;
  /** Final outcome of a batch that did not deliver: logged and passed to the listener. */
  report(failure: DeliveryFailure): void;
}

export class Batcher {
  readonly #options: ResolvedBatchOptions;
  readonly #logger: Logger;
  readonly #send: BatcherOptions['send'];
  readonly #report: BatcherOptions['report'];
  readonly #batchSize: number;

  #queue: WireEvent[] = [];
  #timer: NodeJS.Timeout | undefined;
  /** Serialises flushes so two callers can never drain the same slice. */
  #chain: Promise<unknown> = Promise.resolve();
  /**
   * Event ids already reported as `transport`. An unreachable server must not refire the
   * listener on every flush (CONTRACT-R2 §S2), so a kept batch reports once until it is
   * finally sent or dropped.
   */
  readonly #transportReported = new Set<string>();
  /**
   * Running totals. A `flush()` reports the difference across its own wait, so events settled
   * by an earlier size-triggered drain it queued behind still count toward it.
   */
  #sent = 0;
  #failed = 0;
  #stopped = false;
  readonly #closeBudgetMs: number;
  /** Epoch ms after which a close-initiated drain gives up. Unset outside close. */
  #closeDeadline: number | undefined;
  #exitHook: (() => void) | undefined;

  constructor({
    options,
    maxRequestEvents,
    logger,
    send,
    report,
    closeBudgetMs,
  }: BatcherOptions) {
    this.#options = options;
    this.#closeBudgetMs = closeBudgetMs ?? CLOSE_DRAIN_BUDGET_MS;
    this.#logger = logger;
    this.#send = send;
    this.#report = report;
    this.#batchSize = Math.min(options.size, maxRequestEvents);

    if (options.flushOnExit) {
      this.#exitHook = () => {
        void this.flush();
      };
      process.on('beforeExit', this.#exitHook);
    }
  }

  /** Buffers an event. False when it was dropped instead (stopped, or the queue is full). */
  enqueue(event: WireEvent): boolean {
    if (this.#stopped) {
      this.#logger.error('[intempt] batching is stopped; event dropped', {
        name: event.name,
      });
      this.#drop([event]);
      return false;
    }
    if (this.#queue.length >= this.#options.maxQueue) {
      this.#logger.error('[intempt] batch queue full; event dropped', {
        name: event.name,
        maxQueue: this.#options.maxQueue,
      });
      this.#drop([event]);
      return false;
    }

    this.#queue.push(event);

    if (this.#queue.length >= this.#batchSize) {
      void this.flush();
    } else {
      this.#scheduleFlush(this.#options.flushMs);
    }
    return true;
  }

  /**
   * Drains the queue, sending each batch once under the delivery policy. Resolves
   * when the queue is empty, a batch could not reach the server (kept for the next
   * flush), or a close budget ran out.
   */
  async flush(): Promise<FlushResult> {
    const since = this.#totals();
    const next = this.#chain.then(() => this.#drain());
    // Keep the chain itself settled so one failure cannot poison later flushes.
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
    return this.#since(since);
  }

  #totals(): FlushResult {
    return { sent: this.#sent, failed: this.#failed };
  }

  #since(start: FlushResult): FlushResult {
    return { sent: this.#sent - start.sent, failed: this.#failed - start.failed };
  }

  async #drain(): Promise<void> {
    this.#clearTimer();

    while (this.#queue.length > 0 && !this.#stopped) {
      if (this.#outOfCloseBudget()) return;

      // Take a slice rather than the whole array: events appended during the
      // await stay queued instead of being cleared out from under the send.
      const batch = this.#queue.slice(0, this.#batchSize);
      const outcome = await this.#attempt(batch);

      if (outcome.ok) {
        this.#settle(batch);
        this.#sent += batch.length;
        continue;
      }
      if (outcome.kept) {
        this.#reportTransport(batch, outcome.failure);
        // Ending the drain is what makes "kept" mean "next flush": continuing would
        // resend the same slice in a hot loop against an unreachable host.
        this.#scheduleFlush(this.#options.flushMs);
        return;
      }
      this.#settle(batch);
      this.#failed += batch.length;
      this.#logger.error('[intempt] delivery failed; batch dropped', {
        kind: outcome.failure.kind,
        status: outcome.failure.status,
        count: batch.length,
      });
      this.#report(outcome.failure);
    }
  }

  /** A send callback that throws something other than a policy outcome drops the batch. */
  async #attempt(batch: WireEvent[]): Promise<SendOutcome> {
    try {
      return await this.#send(batch, this.#closeDeadline);
    } catch (error) {
      this.#logger.error('[intempt] batch could not be sent; dropped', error);
      return {
        ok: false,
        kept: false,
        failure: {
          kind: 'dropped',
          eventCount: batch.length,
          eventIds: eventIdsOf(batch),
          terminal: true,
        },
      };
    }
  }

  #settle(batch: WireEvent[]): void {
    this.#queue.splice(0, batch.length);
    for (const id of eventIdsOf(batch)) this.#transportReported.delete(id);
  }

  #reportTransport(batch: WireEvent[], failure: DeliveryFailure): void {
    const fresh = batch.filter((event) =>
      event.payload.some((item) => !this.#transportReported.has(item.eventId)),
    );
    if (fresh.length === 0) return;
    const eventIds = eventIdsOf(fresh);
    for (const id of eventIds) this.#transportReported.add(id);
    this.#logger.warn('[intempt] server unreachable; batch kept for the next flush', {
      count: batch.length,
    });
    this.#report({ ...failure, eventCount: fresh.length, eventIds });
  }

  #drop(events: WireEvent[]): void {
    this.#failed += events.length;
    for (const id of eventIdsOf(events)) this.#transportReported.delete(id);
    this.#report({
      kind: 'dropped',
      eventCount: events.length,
      eventIds: eventIdsOf(events),
      terminal: true,
    });
  }

  /** True once a close-initiated drain has run past its budget. */
  #outOfCloseBudget(): boolean {
    return this.#closeDeadline !== undefined && Date.now() >= this.#closeDeadline;
  }

  #scheduleFlush(ms: number): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, ms);
    // Never hold the event loop open just to wait for a flush.
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Number of events still buffered. */
  get size(): number {
    return this.#queue.length;
  }

  async close(): Promise<FlushResult> {
    const since = this.#totals();
    this.#closeDeadline = Date.now() + this.#closeBudgetMs;
    try {
      await this.flush();
    } finally {
      this.#closeDeadline = undefined;
    }

    // Kept (unreachable) and out-of-budget events are lost here: the process is going
    // down, so they are dropped and reported rather than silently discarded.
    if (this.#queue.length > 0) {
      const left = this.#queue.splice(0);
      this.#logger.error(
        `[intempt] close() dropped ${left.length} unsent event(s) ` +
          `(server unreachable or ${this.#closeBudgetMs}ms budget spent).`,
      );
      this.#drop(left);
    }
    this.#stopped = true;
    this.#clearTimer();
    if (this.#exitHook) {
      process.removeListener('beforeExit', this.#exitHook);
      this.#exitHook = undefined;
    }
    return this.#since(since);
  }
}
