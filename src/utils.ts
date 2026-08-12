/*
    Portions of this file are adapted from mixpanel-node (lib/utils.js),
    Copyright (c) 2012 Carl Sverre, released under the MIT license.
    See NOTICE.
*/

import type { LegacyIdentifiers, Logger } from './types';

const LOGGER_METHODS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

/**
 * Asserts that the provided logger has every method the SDK calls.
 * Adapted from mixpanel-node's `assert_logger`.
 */
export function assertLogger(logger: unknown): asserts logger is Logger {
  if (typeof logger !== 'object' || logger === null) {
    throw new TypeError('"logger" must be a valid Logger object');
  }
  for (const method of LOGGER_METHODS) {
    if (typeof (logger as Record<string, unknown>)[method] !== 'function') {
      throw new TypeError(`Logger object missing "${method}" method`);
    }
  }
}

/**
 * Validates a time value and normalises it to epoch milliseconds.
 * Adapted from mixpanel-node's `ensure_timestamp`.
 */
export function ensureTimestamp(time: Date | number): number {
  if (time instanceof Date) {
    const ms = time.getTime();
    if (Number.isNaN(ms)) {
      throw new TypeError('`timestamp` must be a valid Date or epoch milliseconds');
    }
    return ms;
  }
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new TypeError('`timestamp` must be a valid Date or epoch milliseconds');
  }
  return time;
}

/** Breaks an array into equal-sized chunks, last chunk being the remainder. */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size < 1) {
    throw new RangeError('chunk size must be at least 1');
  }
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * The track and consent endpoints both require at least one identifier.
 * `DataRequest` rejects a payload item carrying none of them.
 *
 * `profileId` counts at runtime because the deprecated 1.x shim still supplies
 * it, but it is not part of the public `Identifiers` type.
 */
export function assertIdentifier(ids: LegacyIdentifiers, method: string): void {
  // Trimmed: a whitespace-only id is truthy in JS but meaningless as an
  // identity, and it would key a profile on " " server-side.
  const present = (value: string | undefined): boolean =>
    typeof value === 'string' && value.trim() !== '';
  if (!present(ids.userId) && !present(ids.accountId) && !present(ids.profileId)) {
    throw new TypeError(`${method}: one of userId or accountId is required`);
  }
}

/**
 * Wraps a logger so a broken one cannot take down a request.
 *
 * The logger is caller-supplied. If its `debug` throws, and the SDK calls it on
 * the path to sending an event, the event is lost to an unrelated bug in someone
 * else's logging setup. Telemetry must not be that fragile.
 */
export function guardLogger(logger: Logger): Logger {
  const guard =
    (level: keyof Logger) =>
    (...args: unknown[]): void => {
      try {
        logger[level](...args);
      } catch {
        // Nothing useful to do: reporting a logging failure needs a logger.
      }
    };
  return {
    trace: guard('trace'),
    debug: guard('debug'),
    info: guard('info'),
    warn: guard('warn'),
    error: guard('error'),
  };
}

/** Drops keys whose value is `undefined` so they never reach the wire. */
export function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
