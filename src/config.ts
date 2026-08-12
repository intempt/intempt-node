/*
    The config-object-plus-setConfig shape is adapted from mixpanel-node
    (lib/mixpanel-node.js DEFAULT_CONFIG / set_config),
    Copyright (c) 2012 Carl Sverre, released under the MIT license.
    See NOTICE.
*/

import type {
  BatchOptions,
  IntemptConfig,
  ResolvedBatchOptions,
  ResolvedConfig,
} from './types';
import { assertLogger } from './utils';

const DEFAULT_CONFIG = {
  host: 'api.intempt.com',
  protocol: 'https' as const,
  path: '',
  timeout: 10_000,
  keepAlive: true,
  debug: false,
  batch: false as const,
  maxRequestEvents: 50,
  maxConcurrentRequests: 1,
};

const DEFAULT_BATCH: ResolvedBatchOptions = {
  size: 50,
  flushMs: 5_000,
  maxQueue: 10_000,
  flushOnExit: true,
};

function resolveBatch(batch: IntemptConfig['batch']): false | ResolvedBatchOptions {
  if (batch === undefined || batch === false) {
    return false;
  }
  const merged: ResolvedBatchOptions = { ...DEFAULT_BATCH, ...batch };
  if (merged.size < 1) {
    throw new RangeError('batch.size must be at least 1');
  }
  if (merged.flushMs < 1) {
    throw new RangeError('batch.flushMs must be at least 1');
  }
  if (merged.maxQueue < merged.size) {
    throw new RangeError('batch.maxQueue must be at least batch.size');
  }
  return merged;
}

/** Splits `host` into host and port, mirroring mixpanel-node's `set_config`. */
function splitHost(host: string): { host: string; port?: number } {
  const [hostname, port] = host.split(':');
  if (!hostname) {
    throw new TypeError('host must not be empty');
  }
  if (port === undefined) {
    return { host: hostname };
  }
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`invalid port in host: ${host}`);
  }
  return { host: hostname, port: parsed };
}

export function resolveConfig(config: IntemptConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    throw new TypeError('Intempt.init requires a config object');
  }
  for (const field of ['org', 'project', 'apiKey'] as const) {
    const value = config[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`Intempt.init: "${field}" is required`);
    }
  }
  if (config.sourceId !== undefined && String(config.sourceId).trim() === '') {
    throw new TypeError('Intempt.init: "sourceId" must not be empty when provided');
  }

  const logger = config.logger ?? console;
  assertLogger(logger);

  const protocol = config.protocol ?? DEFAULT_CONFIG.protocol;
  if (protocol !== 'http' && protocol !== 'https') {
    throw new TypeError(`unsupported protocol "${protocol}"; use "http" or "https"`);
  }

  const timeout = config.timeout ?? DEFAULT_CONFIG.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('timeout must be a positive number of milliseconds');
  }

  const maxRequestEvents = config.maxRequestEvents ?? DEFAULT_CONFIG.maxRequestEvents;
  if (!Number.isInteger(maxRequestEvents) || maxRequestEvents < 1) {
    throw new RangeError('maxRequestEvents must be a positive integer');
  }

  const maxConcurrentRequests =
    config.maxConcurrentRequests ?? DEFAULT_CONFIG.maxConcurrentRequests;
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
    throw new RangeError('maxConcurrentRequests must be a positive integer');
  }

  const { host, port } = splitHost(config.host ?? DEFAULT_CONFIG.host);

  return {
    org: config.org,
    project: config.project,
    ...(config.sourceId !== undefined ? { sourceId: config.sourceId } : {}),
    host,
    ...(port !== undefined ? { port } : {}),
    protocol,
    path: config.path ?? DEFAULT_CONFIG.path,
    timeout,
    keepAlive: config.keepAlive ?? DEFAULT_CONFIG.keepAlive,
    logger,
    debug: config.debug ?? DEFAULT_CONFIG.debug,
    batch: resolveBatch(config.batch),
    maxRequestEvents,
    maxConcurrentRequests,
    ...(config.agent !== undefined ? { agent: config.agent } : {}),
  };
}

/**
 * Applies a partial config over an already-resolved one. Batch mode cannot be
 * turned on or off after construction; the buffer and its timers are wired at
 * init time.
 */
export function mergeConfig(
  current: ResolvedConfig,
  patch: Partial<
    Omit<IntemptConfig, 'org' | 'project' | 'apiKey' | 'sourceId' | 'batch'>
  >,
): ResolvedConfig {
  const next: ResolvedConfig = { ...current };

  if (patch.logger !== undefined) {
    assertLogger(patch.logger);
    next.logger = patch.logger;
  }
  if (patch.host !== undefined) {
    const { host, port } = splitHost(patch.host);
    next.host = host;
    if (port === undefined) {
      delete next.port;
    } else {
      next.port = port;
    }
  }
  if (patch.protocol !== undefined) {
    if (patch.protocol !== 'http' && patch.protocol !== 'https') {
      throw new TypeError(`unsupported protocol "${patch.protocol}"`);
    }
    next.protocol = patch.protocol;
  }
  if (patch.path !== undefined) next.path = patch.path;
  if (patch.timeout !== undefined) {
    if (!Number.isFinite(patch.timeout) || patch.timeout <= 0) {
      throw new RangeError('timeout must be a positive number of milliseconds');
    }
    next.timeout = patch.timeout;
  }
  if (patch.keepAlive !== undefined) next.keepAlive = patch.keepAlive;
  if (patch.debug !== undefined) next.debug = patch.debug;

  return next;
}

export type { BatchOptions };
export { DEFAULT_BATCH };
