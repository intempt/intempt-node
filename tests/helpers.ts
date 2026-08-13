import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import nock from 'nock';
import { Intempt } from '../src';
import type { IntemptConfig, Logger } from '../src';

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

export function feedPath(id: string): string {
  return `/v1/${ORG}/projects/${PROJECT}/feeds/${id}/data`;
}

export function testLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    trace: [],
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      calls[level]!.push(args);
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
