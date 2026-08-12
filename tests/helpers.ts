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
export const BASIC = Buffer.from('pfx0123456789abcdef:sec0123456789abcdef').toString('base64');

export const TRACK_PATH = `/v1/${ORG}/projects/${PROJECT}/sources/${SOURCE}/track`;
export const TRACK_PATH_NO_SOURCE = `/v1/${ORG}/projects/${PROJECT}/track`;
export const CONSENT_PATH = `/v1/${ORG}/projects/${PROJECT}/consents/data`;
export const CHOOSE_PATH = `/v1/${ORG}/projects/${PROJECT}/optimization/choose-api`;

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
  const record = (level: string) => (...args: unknown[]) => {
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

export { nock };
