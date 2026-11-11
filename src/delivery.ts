/**
 * The one HTTP failure policy for every ingestion write (INT-7436, CONTRACT-R2 §S1).
 *
 * Send once. 429 and 503 are the only statuses resent, once, because both mean the server did not
 * ingest the request, so a resend cannot duplicate. Everything else the server answered is dropped:
 * a timeout or a lost response after the body was written may already have landed, and a resend
 * there duplicates events. This replaced a backoff table with a circuit breaker and 413 halving
 * (`harness/FINDINGS.md` R-retry), all of which resent on statuses that can duplicate.
 *
 * Never-reached failures (DNS, refused connection) are the one case worth keeping a batch for: no
 * byte reached the server. The caller decides what "keep" means; direct mode has no queue.
 */

import type { WireEvent } from './types';
import { IntemptApiError } from './transport';

/** Final outcome of one batch that did not deliver. Fired once per batch, never per attempt. */
export interface DeliveryFailure {
  /**
   * `transport`: never reached the server; the batch is kept for the next flush.
   * `terminal`: the server answered a drop status, or the one resend failed.
   * `dropped`: dropped on this side (timeout after write, queue full, wait past the cap, close).
   */
  kind: 'transport' | 'terminal' | 'dropped';
  status?: number;
  eventCount: number;
  eventIds: string[];
  /** Seconds the server asked to wait, when it said. */
  retryAfter?: number;
  terminal: boolean;
}

export type SendOutcome =
  { ok: true } | { ok: false; kept: boolean; failure: DeliveryFailure };

const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
/**
 * A server SDK waits inline, inside a caller's request or shutdown hook, so a longer wait is
 * dropped and reported rather than slept (CONTRACT-R2 §S1.2).
 */
export const SERVER_WAIT_CAP_MS = 5_000;

/**
 * Connect-phase error codes: the request never left this host. A connect TIMEOUT is not here: it
 * surfaces as the generic request timeout, which cannot tell connect from response, so it is
 * dropped rather than risk a duplicate.
 */
const NEVER_REACHED = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export function neverReached(error: IntemptApiError): boolean {
  if (error.status !== undefined) return false;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && NEVER_REACHED.has(code);
}

export function eventIdsOf(events: readonly WireEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    for (const item of event.payload) ids.add(item.eventId);
  }
  return [...ids];
}

export interface DeliverOptions {
  /** Epoch ms past which a resend wait is not started (close budget). */
  deadline?: number;
}

/**
 * Runs `post` under the policy. Resolves with the outcome; rejects only for an error that is not an
 * `IntemptApiError`, which is a programming error (an unserialisable payload) and keeps its
 * pre-existing behaviour.
 */
export async function deliver(
  events: readonly WireEvent[],
  post: () => Promise<unknown>,
  { deadline }: DeliverOptions = {},
): Promise<SendOutcome> {
  const failure = (
    kind: DeliveryFailure['kind'],
    error: IntemptApiError,
  ): DeliveryFailure => ({
    kind,
    ...(error.status !== undefined ? { status: error.status } : {}),
    eventCount: events.length,
    eventIds: eventIdsOf(events),
    ...(error.retryAfterMs !== undefined
      ? { retryAfter: error.retryAfterMs / 1000 }
      : {}),
    terminal: kind !== 'transport',
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      await post();
      return { ok: true };
    } catch (error) {
      if (!(error instanceof IntemptApiError)) throw error;

      if (neverReached(error)) {
        return { ok: false, kept: true, failure: failure('transport', error) };
      }
      if (error.status === undefined) {
        return { ok: false, kept: false, failure: failure('dropped', error) };
      }
      const resendable = error.status === 429 || error.status === 503;
      if (!resendable || attempt > 1) {
        return { ok: false, kept: false, failure: failure('terminal', error) };
      }

      // A Retry-After of 0 or a past HTTP-date arrives as 0 and is floored, so it cannot become an
      // immediate resend.
      const wait = Math.min(
        MAX_WAIT_MS,
        Math.max(MIN_WAIT_MS, error.retryAfterMs ?? MIN_WAIT_MS),
      );
      if (
        wait > SERVER_WAIT_CAP_MS ||
        (deadline !== undefined && Date.now() + wait >= deadline)
      ) {
        return { ok: false, kept: false, failure: failure('dropped', error) };
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
