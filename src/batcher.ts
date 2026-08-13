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
/** Floor for any retry, so a zero or past Retry-After cannot become a hot loop. */
const MIN_RETRY_INTERVAL_MS = 100;
const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * Consecutive single-event 413 drops, with no successful send in between, before
 * saying so once.
 *
 * Diagnostic only. Two earlier versions used this tally to change behaviour and
 * both were worse than what they fixed:
 *
 * - Stopping batching stranded the queue and discarded every later event, where
 *   the original merely dropped the oversized ones.
 * - Pinning the width to 1 capped throughput to one event per round trip. The
 *   width then has to climb back through the widening ramp — measured at 37
 *   requests to deliver 120 events instead of about 15 — and a producer faster
 *   than that overflows maxQueue, so good events are lost. Trading data loss for
 *   request count is the wrong direction.
 *
 * What the tally is actually good for is telling an operator to go and look at the
 * gateway. The cost it was trying to avoid — about log2(size) requests per dropped
 * event, because the width resets to full and the halving chain replays — is real
 * but is only paid while events are being dropped, which is already an error
 * condition logged on every occurrence.
 */
const DROPS_BEFORE_WARNING = 3;
/**
 * Successful sends at a reduced width before trying a wider one again.
 *
 * A 413 is usually about payload size, which is a property of the events rather
 * than a transient condition, so retrying the wider width immediately just
 * alternates 413/200 forever. Waiting for a run of successes bounds that to one
 * oversized attempt in eleven while still letting throughput recover.
 */
const SUCCESSES_BEFORE_WIDENING = 10;

export interface BatcherOptions {
  options: ResolvedBatchOptions;
  /** Hard ceiling on events per request; caps the flush width. */
  maxRequestEvents: number;
  logger: Logger;
  /** Sends one chunk. Rejects with `IntemptApiError` on failure. */
  send(events: WireEvent[]): Promise<unknown>;
}

export class Batcher {
  readonly #options: ResolvedBatchOptions;
  readonly #maxRequestEvents: number;
  readonly #logger: Logger;
  readonly #send: (events: WireEvent[]) => Promise<unknown>;

  #queue: WireEvent[] = [];
  #batchSize: number;
  #timer: NodeJS.Timeout | undefined;
  /** Serialises flushes so two callers can never drain the same slice. */
  #chain: Promise<void> = Promise.resolve();
  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #consecutiveDrops = 0;
  #stopped = false;
  #exitHook: (() => void) | undefined;

  constructor({ options, maxRequestEvents, logger, send }: BatcherOptions) {
    this.#options = options;
    this.#maxRequestEvents = maxRequestEvents;
    this.#logger = logger;
    this.#send = send;
    this.#batchSize = Math.min(options.size, maxRequestEvents);

    if (options.flushOnExit) {
      this.#exitHook = () => {
        void this.flush();
      };
      process.on('beforeExit', this.#exitHook);
    }
  }

  /**
   * Buffers an event, or logs and drops it when batching has stopped or the
   * queue is full.
   *
   * Returns nothing on purpose. It used to return a boolean for "dropped", which
   * the only caller discarded, so the three branches carrying that value were
   * untestable through any public surface — mutation testing flagged them as
   * unkillable. A drop is reported through the logger, which is the channel
   * callers actually have.
   */
  enqueue(event: WireEvent): void {
    if (this.#stopped) {
      this.#logger.error('[intempt] batching is stopped; event dropped', {
        name: event.name,
      });
      return;
    }
    if (this.#queue.length >= this.#options.maxQueue) {
      this.#logger.error('[intempt] batch queue full; event dropped', {
        name: event.name,
        maxQueue: this.#options.maxQueue,
      });
      return;
    }

    this.#queue.push(event);

    if (this.#queue.length >= this.#batchSize) {
      void this.flush();
    } else {
      this.#scheduleFlush(this.#options.flushMs);
    }
  }

  /**
   * Drains the queue. Awaiting this resolves only once the queue is empty or
   * the batcher has stopped, so `close()` cannot return with events buffered.
   */
  async flush(): Promise<void> {
    const next = this.#chain.then(() => this.#drain());
    // Keep the chain itself settled so one failure cannot poison later flushes.
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #drain(): Promise<void> {
    this.#clearTimer();

    while (this.#queue.length > 0 && !this.#stopped) {
      // Take a slice rather than the whole array: events appended during the
      // await stay queued instead of being cleared out from under the send.
      const batch = this.#queue.slice(0, this.#batchSize);

      try {
        await this.#send(batch);
      } catch (error) {
        const handled = await this.#handleFailure(error, batch);
        if (handled === 'requeue') continue;
        if (handled === 'stop') return;
      }

      this.#queue.splice(0, batch.length);
      this.#consecutiveFailures = 0;
      this.#consecutiveDrops = 0;

      // Widen back toward full after a run of successes at the current width.
      //
      // This used to compare `batch.length >= full`, which could never be true:
      // `batch` is sliced to #batchSize, so once a 413 halved the width the
      // condition was unreachable and the reduction became permanent for the
      // life of the client. One transient 413 halved throughput forever.
      // Mutation testing found it — the comparison was unkillable because no
      // input could reach it.
      //
      // Resetting to full on every success is the opposite failure: it undoes
      // the halving immediately, so the next request is oversized again and the
      // batcher alternates 413/200 at double the request count, with the
      // breaker never tripping because each success clears the counter. Hence
      // the run of successes and the doubling rather than a jump to full.
      //
      // Only a send that filled the current width counts, so a trickle producer
      // flushing two events per tick at a width of eight earns nothing.
      //
      // The one width this cannot filter is 1, where `batch.length >= 1` always
      // holds — and 1 is exactly where a halving chain bottoms out. Ten successful
      // single-event sends therefore do widen 1 to 2. That is the intended floor
      // rather than an oversight: at a width of 1 no stronger evidence exists to
      // wait for, and 2 is the smallest step that can gather any.
      const full = Math.min(this.#options.size, this.#maxRequestEvents);
      if (this.#batchSize < full && batch.length >= this.#batchSize) {
        this.#consecutiveSuccesses += 1;
        if (this.#consecutiveSuccesses >= SUCCESSES_BEFORE_WIDENING) {
          this.#batchSize = Math.min(full, this.#batchSize * 2);
          this.#consecutiveSuccesses = 0;
        }
      }
    }
  }

  /**
   * 413 (batch > 1)  halve the batch size and retry
   * 413 (batch = 1)  drop the event, log it; stop after MAX_CONSECUTIVE_DROPS
   * 429              honour Retry-After, else exponential backoff
   * 5xx / 408        exponential backoff
   * timeout          exponential backoff
   * other 4xx        drop the batch, surface the error
   */
  async #handleFailure(error: unknown, batch: WireEvent[]): Promise<'requeue' | 'stop'> {
    const apiError = error instanceof IntemptApiError ? error : undefined;
    const status = apiError?.status;

    // Any failure ends the run of successes, whichever branch handles it. A
    // widening decision should rest on an unbroken streak. This used to sit lower
    // down, below the 413 and non-retryable branches, so it was reachable only for
    // retryable errors: nine successes at a reduced width plus one 400 plus one
    // success still widened, which is the exact case the comment claimed to
    // prevent, one status class over.
    this.#consecutiveSuccesses = 0;

    if (status === 413) {
      if (batch.length > 1) {
        this.#batchSize = Math.max(1, Math.floor(batch.length / 2));
        this.#logger.warn(
          `[intempt] 413 received; reducing batch size to ${this.#batchSize}`,
        );
        return 'requeue';
      }
      this.#logger.error('[intempt] single event too large; dropping', {
        name: batch[0]?.name,
      });
      this.#queue.splice(0, 1);
      this.#consecutiveFailures = 0;
      this.#consecutiveDrops += 1;

      // The offending event is gone, so the width was never the problem: go back to
      // full rather than leaving the next batch narrowed. Anything that keeps the
      // width down here costs delivered events, because the widening ramp then has
      // to climb back one doubling per ten successes while the producer keeps
      // filling the queue.
      this.#batchSize = Math.min(this.#options.size, this.#maxRequestEvents);

      // Say something once when drops keep coming with nothing accepted in
      // between. That pattern means the gateway's body limit is below a single
      // event, which no retry policy can work around — only a human can.
      if (this.#consecutiveDrops === DROPS_BEFORE_WARNING) {
        this.#logger.error(
          `[intempt] ${this.#consecutiveDrops} events rejected as too large with none ` +
            `accepted in between. The gateway's request body limit is likely below a ` +
            `single event; every event will be dropped until it is raised.`,
        );
      }
      return 'requeue';
    }

    if (apiError && !apiError.retryable) {
      this.#logger.error('[intempt] non-retryable error; dropping batch', {
        status,
        body: apiError.body,
        count: batch.length,
      });
      this.#queue.splice(0, batch.length);
      // Dropping a malformed batch is not a transient failure, so it must not
      // count toward the circuit breaker. Leaving the tally standing meant one
      // 400 plus four earlier 500s stopped batching on the next transient blip.
      this.#consecutiveFailures = 0;
      return 'requeue';
    }

    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.#logger.error(
        `[intempt] ${this.#consecutiveFailures} consecutive failures; stopping batching. ` +
          `${this.#queue.length} event(s) remain buffered.`,
        error,
      );
      this.#stopped = true;
      return 'stop';
    }

    // A Retry-After of 0, or an HTTP-date already in the past, arrives here as 0.
    // `??` treats that as a real instruction and retries immediately, burning
    // every attempt in milliseconds and hammering the endpoint. Only honour a
    // positive value, and never back off less than the flush interval.
    const advised =
      apiError?.retryAfterMs !== undefined && apiError.retryAfterMs > 0
        ? apiError.retryAfterMs
        : undefined;
    const backoff = Math.min(
      MAX_RETRY_INTERVAL_MS,
      Math.max(
        // A small floor, not flushMs: flooring at the flush interval would
        // override a server that legitimately asked for a short wait.
        MIN_RETRY_INTERVAL_MS,
        advised ?? this.#options.flushMs * 2 ** this.#consecutiveFailures,
      ),
    );
    this.#logger.warn(`[intempt] send failed; retrying in ${backoff}ms`, error);
    await delay(backoff);
    return 'requeue';
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

  async close(): Promise<void> {
    await this.flush();
    this.#stopped = true;
    this.#clearTimer();
    if (this.#exitHook) {
      process.removeListener('beforeExit', this.#exitHook);
      this.#exitHook = undefined;
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
