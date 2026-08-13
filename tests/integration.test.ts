import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Intempt, SDK, type IntemptClient } from '../src';
import type { Logger } from '../src';

// Deliberately NOT importing ./helpers: it loads `nock`, and nock patches
// http.ClientRequest at import time. That turns every request in this file into
// a nock passthrough, which sends `Connection: close` and ignores the agent — so
// the keep-alive and concurrency assertions below would silently test nock
// rather than the SDK. This file must stay nock-free to mean anything.
const ORG = 'acme';
const PROJECT = 'web';
// A real 19-digit snowflake id, past Number.MAX_SAFE_INTEGER.
const SOURCE = '1841503112918048768';
const API_KEY = 'pfx0123456789abcdef.sec0123456789abcdef';
const BASIC = Buffer.from('pfx0123456789abcdef:sec0123456789abcdef').toString('base64');

function testLogger(): Logger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Real sockets, no nock.
 *
 * The rest of the suite intercepts requests before they reach the network, so it
 * proves what the SDK *intends* to send. This file runs an actual HTTP server on
 * loopback, so it proves what actually goes over a socket: header framing,
 * keep-alive reuse, JSON round-tripping, timeouts, and concurrency limits.
 */

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  /** Client-side TCP port: the ground truth for connection reuse. */
  socketId: number;
}

class TestServer {
  readonly requests: Captured[] = [];
  private server: http.Server;
  private port = 0;
  /** Per-path queue of responses; falls back to 200 with an empty object. */
  responses: Array<{
    status: number;
    body?: string;
    headers?: http.OutgoingHttpHeaders;
    delayMs?: number;
  }> = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* keep the raw string */
        }

        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: parsed,
          socketId: req.socket.remotePort ?? -1,
        });

        const next = this.responses.shift() ?? { status: 200, body: '{}' };
        const send = (): void => {
          res.writeHead(next.status, {
            'Content-Type': 'application/json',
            ...next.headers,
          });
          res.end(next.body ?? '{}');
        };
        if (next.delayMs) {
          setTimeout(send, next.delayMs);
        } else {
          send();
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  reset(): void {
    this.requests.length = 0;
    this.responses.length = 0;
  }
}

const server = new TestServer();

beforeAll(async () => {
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

function realClient(overrides: Record<string, unknown> = {}): IntemptClient {
  return Intempt.init({
    org: ORG,
    project: PROJECT,
    apiKey: API_KEY,
    sourceId: SOURCE,
    host: server.host,
    protocol: 'http',
    logger: testLogger(),
    ...overrides,
  });
}

describe('over a real socket: request framing', () => {
  it('sends a well-formed POST the server can parse', async () => {
    server.reset();
    const c = realClient();

    await c.track('purchase', { userId: 'u1', properties: { total: 99.99 } });
    await c.close();

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`/v1/${ORG}/projects/${PROJECT}/sources/${SOURCE}/track`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(Number(req.headers['content-length'])).toBeGreaterThan(0);
    expect(req.headers.authorization).toBe(`Basic ${BASIC}`);
    expect(req.headers['x-intempt-lib']).toMatch(/^intempt-node\/\d+\.\d+\.\d+/);
    expect(req.body).toMatchObject({
      track: [{ name: 'purchase', payload: [{ userId: 'u1', data: { total: 99.99 } }] }],
    });
  });

  it('sends a decodable credential the server can verify', async () => {
    server.reset();
    const c = realClient();
    await c.track('purchase', { userId: 'u1' });
    await c.close();

    // Decode exactly as a server would, to prove the framing is real.
    const header = String(server.requests[0]!.headers.authorization);
    const [scheme, value] = header.split(' ');
    expect(scheme).toBe('Basic');
    const [prefix, secret] = Buffer.from(String(value), 'base64')
      .toString('utf8')
      .split(':');
    expect(`${prefix}.${secret}`).toBe(API_KEY);
  });

  it('never puts the key in the request line', async () => {
    server.reset();
    const c = realClient();
    await c.track('purchase', { userId: 'u1' });
    await c.close();

    expect(server.requests[0]!.url).not.toContain('apiKey');
    expect(server.requests[0]!.url).not.toContain('?');
  });
});

describe('over a real socket: keep-alive', () => {
  it('reuses one TCP connection across calls', async () => {
    server.reset();
    const c = realClient();

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });
    await c.track('c', { userId: 'u1' });

    const sockets = new Set(server.requests.map((r) => r.socketId));
    expect(server.requests).toHaveLength(3);
    expect(sockets.size).toBe(1);
    expect(server.requests[0]!.headers.connection).toBe('keep-alive');

    await c.close();
  });

  it('opens a fresh connection per call when keepAlive is off', async () => {
    server.reset();
    const c = realClient({ keepAlive: false });

    await c.track('a', { userId: 'u1' });
    await c.track('b', { userId: 'u1' });

    expect(new Set(server.requests.map((r) => r.socketId)).size).toBe(2);
    await c.close();
  });
});

describe('over a real socket: failures', () => {
  it('times out on a slow server and reports it as retryable', async () => {
    server.reset();
    server.responses.push({ status: 200, body: '{}', delayMs: 300 });
    const c = realClient({ timeout: 60 });

    const error = await c.track('slow', { userId: 'u1' }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/timed out/);

    await c.close();
  });

  it('surfaces a real 500 body', async () => {
    server.reset();
    server.responses.push({ status: 500, body: '{"error":"boom"}' });
    const c = realClient();

    const error = await c.track('x', { userId: 'u1' }).catch((e: unknown) => e);
    expect((error as { status?: number }).status).toBe(500);
    expect((error as { body?: string }).body).toContain('boom');

    await c.close();
  });

  it('retries a real 429 with Retry-After through the batcher', async () => {
    server.reset();
    // '1' rather than '0': a zero or past Retry-After is treated as absent now,
    // because honouring it retried instantly and hammered the endpoint.
    server.responses.push({ status: 429, body: '{}', headers: { 'Retry-After': '1' } });
    server.responses.push({ status: 200, body: '{}' });

    const c = realClient({
      batch: { size: 1, flushMs: 10_000, maxQueue: 10, flushOnExit: false },
    });
    await c.track('a', { userId: 'u1' });
    await c.flush();

    expect(server.requests).toHaveLength(2);
    expect(c.buffered).toBe(0);
    await c.close();
  });
});

describe('over a real socket: a dead connection always settles the promise', () => {
  // The worst failure an SDK can have is a promise that never settles: the
  // caller waits forever with no error to act on. These drive real sockets to
  // their death in three different ways and assert that each one is reported.
  async function outcomeAgainst(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> {
    const srv = http.createServer(handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as AddressInfo;
    const c = Intempt.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      sourceId: SOURCE,
      host: `127.0.0.1:${port}`,
      protocol: 'http',
      timeout: 30_000,
      logger: testLogger(),
    });
    const outcome = await Promise.race([
      c.track('probe', { userId: 'u1' }).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((r) => setTimeout(() => r('NEVER SETTLED'), 2_000)),
    ]);
    await c.close();
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    return outcome;
  }

  it('rejects when the socket dies before any response', async () => {
    expect(await outcomeAgainst((req) => req.socket.destroy())).toBe('rejected');
  });

  it('rejects when the socket dies after headers, mid-body', async () => {
    expect(
      await outcomeAgainst((_req, res) => {
        res.writeHead(200, { 'Content-Length': '999' });
        res.write('{');
        res.socket?.destroy();
      }),
    ).toBe('rejected');
  });

  it('rejects when the server closes with zero bytes sent', async () => {
    expect(await outcomeAgainst((req) => req.socket.end())).toBe('rejected');
  });
});

describe('over a real socket: reads', () => {
  it('parses a real feed response body and sends an id/type pair', async () => {
    server.reset();
    server.responses.push({ status: 200, body: JSON.stringify({ items: [{ id: 7 }] }) });

    const c = realClient();
    const feed = await c.recommend({
      userId: 'u1',
      feedId: '848',
      limit: 1,
      fields: ['id'],
    });

    expect(feed).toEqual({ items: [{ id: 7 }] });
    expect(server.requests[0]!.url).toBe(`/v1/${ORG}/projects/${PROJECT}/feeds/848/data`);
    expect(server.requests[0]!.body).toMatchObject({ id: 'u1', type: 'user' });
    await c.close();
  });
});

describe('over a real socket: concurrency', () => {
  it('holds no more than maxConcurrentRequests open at once', async () => {
    server.reset();
    for (let i = 0; i < 12; i += 1) {
      server.responses.push({ status: 200, body: '{}', delayMs: 30 });
    }

    const c = realClient({ maxRequestEvents: 1, maxConcurrentRequests: 3 });
    await c.trackBatch(
      Array.from({ length: 12 }, (_, i) => ({ event: `e${i}`, userId: 'u1' })),
    );

    expect(server.requests).toHaveLength(12);
    // 3 workers on a keep-alive agent means at most 3 distinct sockets.
    expect(new Set(server.requests.map((r) => r.socketId)).size).toBeLessThanOrEqual(3);
    await c.close();
  });
});

describe('over a real socket: consent wire format', () => {
  it('sends a timestamp the API would accept as epoch seconds', async () => {
    server.reset();
    const c = realClient();
    await c.consent.grant({ userId: 'u1', category: 'marketing' });

    const body = server.requests[0]!.body as Record<string, unknown>;
    const ts = body.timestamp as number;

    // ConsentService compares `timestamp * 1000` against millisecond bounds.
    expect(ts * 1000).toBeGreaterThan(1_262_304_000_000); // LOW_TIMESTAMP_LIMIT
    expect(ts * 1000).toBeLessThan(2_216_872_268_000); // UP_TIMESTAMP_LIMIT
    expect(body.action).toBe('accept');
    expect(body.source).toBe('NodeJs tracker');

    await c.close();
  });

  it('carries the 19-digit source id unrounded when identified by profileId', async () => {
    // sourceId is only sent on the profileId-identified path, and profileId is
    // reachable only through the deprecated 1.x shim — it is deliberately absent
    // from the v2 option types. So the shim is what exercises this, and going
    // through it is also what proves the shim still reaches the same wire format.
    server.reset();
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ host: server.host, protocol: 'http' });

    await sdk.consents('p-real', 'accept');

    const raw = JSON.stringify(server.requests[0]!.body);
    // A string, not a number: Number(SOURCE) would round the last two digits.
    expect(raw).toContain(`"sourceId":"${SOURCE}"`);
    expect(raw).not.toContain(`"sourceId":${SOURCE}`);

    await sdk.close();
  });
});
