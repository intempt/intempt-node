import { describe, expect, it } from 'vitest';
import { Intempt } from '../src';
import { API_KEY, HOST, ORG, ORIGIN, PROJECT, TRACK_PATH, client, nock, setupNock, testLogger } from './helpers';

setupNock();

const base = { org: ORG, project: PROJECT, apiKey: API_KEY };

describe('config: required fields', () => {
  it.each(['org', 'project', 'apiKey'])('rejects a missing %s', (field) => {
    const config: Record<string, unknown> = { ...base };
    delete config[field];
    expect(() => Intempt.init(config as never)).toThrow(new RegExp(`"${field}" is required`));
  });

  it.each(['', '   '])('rejects a blank required field (%j)', (value) => {
    expect(() => Intempt.init({ ...base, org: value })).toThrow(/"org" is required/);
  });

  it('rejects a non-object config', () => {
    expect(() => Intempt.init(undefined as never)).toThrow(/requires a config object/);
  });

  it('rejects an empty sourceId when the key is present', () => {
    expect(() => Intempt.init({ ...base, sourceId: '' })).toThrow(/sourceId/);
  });
});

describe('config: defaults', () => {
  it('targets production over https with batching off', () => {
    const c = Intempt.init(base);
    expect(c.config).toMatchObject({
      host: 'api.intempt.com',
      protocol: 'https',
      path: '',
      timeout: 10_000,
      keepAlive: true,
      debug: false,
      batch: false,
      maxRequestEvents: 50,
    });
  });

  it('never selects a staging host from NODE_ENV', () => {
    // 1.x switched to api.staging.intempt.com whenever NODE_ENV === 'test',
    // so any consumer running their own test suite shipped data to staging.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(Intempt.init(base).config.host).toBe('api.intempt.com');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('defaults the logger to console and validates a custom one', () => {
    expect(Intempt.init(base).config.logger).toBe(console);
    expect(() => Intempt.init({ ...base, logger: {} as never })).toThrow(/missing "trace"/);
    expect(() => Intempt.init({ ...base, logger: 'nope' as never })).toThrow(
      /must be a valid Logger/,
    );
  });
});

describe('config: validation', () => {
  it('rejects an unsupported protocol', () => {
    expect(() => Intempt.init({ ...base, protocol: 'ftp' as never })).toThrow(
      /unsupported protocol/,
    );
  });

  it.each([0, -1, Number.NaN])('rejects a timeout of %j', (timeout) => {
    expect(() => Intempt.init({ ...base, timeout })).toThrow(/timeout must be a positive/);
  });

  it('rejects a non-integer maxRequestEvents', () => {
    expect(() => Intempt.init({ ...base, maxRequestEvents: 0 })).toThrow(/maxRequestEvents/);
    expect(() => Intempt.init({ ...base, maxRequestEvents: 1.5 })).toThrow(/maxRequestEvents/);
  });

  it('splits host:port and rejects a bad port', () => {
    expect(Intempt.init({ ...base, host: 'localhost:9000' }).config).toMatchObject({
      host: 'localhost',
      port: 9000,
    });
    expect(() => Intempt.init({ ...base, host: 'localhost:abc' })).toThrow(/invalid port/);
    expect(() => Intempt.init({ ...base, host: '' })).toThrow(/host must not be empty/);
  });

  it('validates batch options', () => {
    expect(() => Intempt.init({ ...base, batch: { size: 0 } })).toThrow(/batch.size/);
    expect(() => Intempt.init({ ...base, batch: { flushMs: 0 } })).toThrow(/batch.flushMs/);
    expect(() => Intempt.init({ ...base, batch: { size: 10, maxQueue: 5 } })).toThrow(
      /maxQueue must be at least/,
    );
  });

  it('fills batch defaults when given an empty object', () => {
    expect(Intempt.init({ ...base, batch: {} }).config.batch).toEqual({
      size: 50,
      flushMs: 5_000,
      maxQueue: 10_000,
      flushOnExit: true,
    });
  });
});

describe('config: setConfig', () => {
  it('applies a patch to a live client', async () => {
    const c = client();
    const logger = testLogger();

    c.setConfig({ timeout: 250, debug: true, logger });

    expect(c.config.timeout).toBe(250);
    expect(c.config.debug).toBe(true);
    expect(c.config.logger).toBe(logger);

    nock(ORIGIN).post(TRACK_PATH).reply(200, '');
    await c.track('purchase', { userId: 'u1' });
    expect(logger.calls.debug.length).toBeGreaterThan(0);
  });

  it('routes to a new host after a patch', async () => {
    const c = client();
    const scope = nock('https://other.test.local').post(TRACK_PATH).reply(200, '');

    c.setConfig({ host: 'other.test.local' });
    await c.track('purchase', { userId: 'u1' });

    scope.done();
  });

  it('clears a port when the new host has none', () => {
    const c = client({ host: `${HOST}:8443` });
    expect(c.config.port).toBe(8443);
    c.setConfig({ host: HOST });
    expect(c.config.port).toBeUndefined();
  });

  it('still validates on patch', () => {
    const c = client();
    expect(() => c.setConfig({ timeout: -1 })).toThrow(/timeout/);
    expect(() => c.setConfig({ protocol: 'ftp' as never })).toThrow(/unsupported protocol/);
    expect(() => c.setConfig({ logger: {} as never })).toThrow(/missing/);
  });
});

describe('config: path prefix', () => {
  it('prepends a configured path before /v1', async () => {
    const scope = nock(ORIGIN).post(`/gw${TRACK_PATH}`).reply(200, '');
    await client({ path: '/gw' }).track('purchase', { userId: 'u1' });
    scope.done();
  });

  it('url-encodes org and project', async () => {
    const scope = nock(ORIGIN)
      .post('/v1/a%20co/projects/my%2Fproj/track')
      .reply(200, '');

    await Intempt.init({
      org: 'a co',
      project: 'my/proj',
      apiKey: API_KEY,
      host: HOST,
      logger: testLogger(),
    }).track('purchase', { userId: 'u1' });

    scope.done();
  });
});
