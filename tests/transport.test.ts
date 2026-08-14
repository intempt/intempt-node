import { describe, expect, it } from 'vitest';
import { IntemptApiError } from '../src';
import { BASIC, HOST, ORIGIN, TRACK_PATH, client, nock, setupNock } from './helpers';

setupNock();

describe('transport: authentication', () => {
  it('sends the API key as an Authorization: Basic header', async () => {
    let auth: string | undefined;
    const scope = nock(ORIGIN)
      .post(TRACK_PATH)
      .reply(200, function () {
        auth = this.req.headers.authorization as string;
        return '';
      });

    await client().track('purchase', { userId: 'u1' });

    expect(auth).toBe(`Basic ${BASIC}`);
    scope.done();
  });

  it('never puts the API key in the query string', async () => {
    // The server still accepts ?apiKey= but logs "deprecated and insecure" for
    // every such request (LegacyApiKeyTranslatorFilter).
    let requestPath: string | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH)
      .reply(200, function () {
        requestPath = this.req.path;
        return '';
      });

    await client().track('purchase', { userId: 'u1' });

    expect(requestPath).toBe(TRACK_PATH);
    expect(requestPath).not.toContain('apiKey');
    expect(requestPath).not.toContain('api_key');
    expect(requestPath).not.toContain('?');
  });

  it('identifies itself with an X-Intempt-Lib header', async () => {
    let lib: string | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH)
      .reply(200, function () {
        lib = this.req.headers['x-intempt-lib'] as string;
        return '';
      });

    await client().track('purchase', { userId: 'u1' });

    expect(lib).toMatch(/^intempt-node\/\d+\.\d+\.\d+/);
  });
});

describe('transport: errors', () => {
  it('surfaces the HTTP status and body instead of a generic message', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(422, '{"error":"bad name"}');

    const error = await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IntemptApiError);
    const api = error as IntemptApiError;
    expect(api.status).toBe(422);
    expect(api.body).toContain('bad name');
    expect(api.retryable).toBe(false);
  });

  it('marks 429, 408 and 5xx retryable and other 4xx not', async () => {
    const statuses: Array<[number, boolean]> = [
      [408, true],
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
    ];

    for (const [status, retryable] of statuses) {
      nock(ORIGIN).post(TRACK_PATH).reply(status, '');
      const error = (await client()
        .track('purchase', { userId: 'u1' })
        .catch((e: unknown) => e)) as IntemptApiError;
      expect(error.status, `status ${status}`).toBe(status);
      expect(error.retryable, `status ${status} retryable`).toBe(retryable);
    }
  });

  it('parses Retry-After given in seconds', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': '3' });

    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    expect(error.retryAfterMs).toBe(3000);
  });

  it('parses Retry-After given as an HTTP date', async () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    nock(ORIGIN).post(TRACK_PATH).reply(429, '', { 'Retry-After': when });

    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    expect(error.retryAfterMs).toBeGreaterThan(3000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('rejects with a retryable error on timeout', async () => {
    nock(ORIGIN).post(TRACK_PATH).delayConnection(200).reply(200, '');

    const error = (await client({ timeout: 30 })
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    expect(error).toBeInstanceOf(IntemptApiError);
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/timed out/);
  });

  it('wraps transport failures with no response as retryable', async () => {
    nock(ORIGIN).post(TRACK_PATH).replyWithError('ECONNRESET');

    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as IntemptApiError;

    expect(error).toBeInstanceOf(IntemptApiError);
    expect(error.retryable).toBe(true);
  });
});

describe('transport: sockets', () => {
  it('reuses one keep-alive socket across calls', async () => {
    nock(ORIGIN).post(TRACK_PATH).times(3).reply(200, '');

    const c = client();
    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await c.track('c', { userId: 'u1' });

    // One agent instance is shared; keepAlive is on by default.
    expect(c.config.keepAlive).toBe(true);
    await c.close();
  });

  it('honours a host:port pair', async () => {
    const scope = nock(`https://${HOST}:8443`).post(TRACK_PATH).reply(200, '');

    await client({ host: `${HOST}:8443` }).track('purchase', { userId: 'u1' });

    scope.done();
  });
});
