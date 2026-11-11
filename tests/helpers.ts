import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import nock from 'nock';
import { Intempt } from '../src';
import type { IntemptConfig, Logger } from '../src';
import { ApiKeyCredentials } from '../src/credentials';
import { resolveConfig } from '../src/config';
import { Transport } from '../src/transport';

export const HOST = 'api.test.local';
export const ORIGIN = `https://${HOST}`;
export const ORG = 'acme';
export const PROJECT = 'web';
export const SOURCE = '684508596718616576';
export const API_KEY = 'pfx0123456789abcdef.sec0123456789abcdef';
export const BASIC = Buffer.from('pfx0123456789abcdef:sec0123456789abcdef').toString(
  'base64',
);

export const TRACK_PATH = `/v1/${ORG}/projects/${PROJECT}/sources/${SOURCE}/track`;
export const TRACK_PATH_NO_SOURCE = `/v1/${ORG}/projects/${PROJECT}/track`;
export const CONSENT_PATH = `/v1/${ORG}/projects/${PROJECT}/consents/data`;
export const CHOOSE_PATH = `/v1/${ORG}/projects/${PROJECT}/optimization/choose-api`;

export function feedPath(id: string): string {
  return `/v1/${ORG}/projects/${PROJECT}/feeds/${id}/data`;
}

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * `calls` is keyed by the five known levels rather than by `Record<string, …>`.
 * The index-signature version was only assertable with a `!` at every call site,
 * because `noUncheckedIndexedAccess` widens each lookup to `| undefined` — and
 * once `npm run typecheck` started covering tests, that produced 27 errors.
 */
export function testLogger(): Logger & { calls: Record<LogLevel, unknown[][]> } {
  const calls: Record<LogLevel, unknown[][]> = {
    trace: [],
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const record =
    (level: LogLevel) =>
    (...args: unknown[]) => {
      calls[level].push(args);
    };
  return {
    calls,
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

export function client(overrides: Partial<IntemptConfig> = {}) {
  return Intempt.init({
    org: ORG,
    project: PROJECT,
    apiKey: API_KEY,
    sourceId: SOURCE,
    host: HOST,
    logger: testLogger(),
    ...overrides,
  });
}

/** Blocks every unmocked request so a stray call fails loudly. */
export function setupNock(): void {
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
  });
  afterAll(() => {
    nock.enableNetConnect();
  });
}

/**
 * Polls until `predicate` holds, instead of sleeping a fixed amount.
 *
 * A fixed sleep is a race: the suite ran green alone and failed two tests while
 * a mutation run saturated all eight cores, because 200ms of wall clock is not
 * 200ms of scheduling. Polling makes the assertion depend on the condition
 * rather than on how busy the machine is.
 */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition still false after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export { nock };

/**
 * The `IntemptApiError` one track request produces, read straight off the transport.
 *
 * `track()` no longer rejects for a delivery failure (INT-7436/7444, CONTRACT-R2 §S1/S2), so tests
 * that inspect how a response or socket failure is classified read it here instead.
 */
export async function postError(
  overrides: Partial<IntemptConfig> = {},
  body: unknown = { track: [] },
): Promise<unknown> {
  const resolved = resolveConfig({
    org: ORG,
    project: PROJECT,
    apiKey: API_KEY,
    sourceId: SOURCE,
    host: HOST,
    logger: testLogger(),
    ...overrides,
  });
  const transport = new Transport(
    resolved,
    new ApiKeyCredentials(overrides.apiKey ?? API_KEY),
  );
  try {
    await transport.post(TRACK_PATH, body);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    transport.destroy();
  }
}
