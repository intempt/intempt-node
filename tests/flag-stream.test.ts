import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagStream } from '../src/flag-stream';
import type { StreamHandle, StreamHandlers } from '../src/flag-stream';
import { IntemptFlags } from '../src/flags';
import { API_KEY, ORG, PROJECT, testLogger } from './helpers';

/**
 * F15 stream half (C2): one SSE connection to `/flags/stream`, reconnect backoff 1 s doubling to
 * 60 s, a 60 s cache per (key, person) used only while connected, dropped at once on a
 * `flags_changed` event. The connection is a local fake server on loopback; no real network.
 */
const STREAM_PATH = `/v1/${ORG}/projects/${PROJECT}/flags/stream`;
const EVALUATE_PATH = `/v1/${ORG}/projects/${PROJECT}/flags/evaluate`;

describe('FlagStream reconnect', () => {
  let handlers: StreamHandlers[];
  let closed: number;
  const open = (h: StreamHandlers): StreamHandle => {
    handlers.push(h);
    return { close: () => void closed++ };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = [];
    closed = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('retries after 1 s, doubling to a 60 s ceiling', () => {
    const stream = new FlagStream({ open, onChange: () => {}, onState: () => {} });
    stream.start();
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const before = handlers.length;
      handlers[before - 1]!.onClose();
      let waited = 0;
      while (handlers.length === before) {
        vi.advanceTimersByTime(1);
        waited++;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    stream.close();
  });

  it('starts over at 1 s after a connection was made', () => {
    const stream = new FlagStream({ open, onChange: () => {}, onState: () => {} });
    stream.start();
    handlers[0]!.onClose();
    vi.advanceTimersByTime(1000);
    handlers[1]!.onClose();
    vi.advanceTimersByTime(2000);
    handlers[2]!.onOpen();
    handlers[2]!.onClose();
    vi.advanceTimersByTime(999);
    expect(handlers).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(handlers).toHaveLength(4);
    stream.close();
  });

  it('reports connected only between open and close, and stops on close()', () => {
    const states: boolean[] = [];
    const stream = new FlagStream({
      open,
      onChange: () => {},
      onState: (c) => void states.push(c),
    });
    stream.start();
    stream.start();
    expect(handlers).toHaveLength(1);
    handlers[0]!.onOpen();
    expect(stream.connected).toBe(true);
    stream.close();
    expect(closed).toBe(1);
    expect(stream.connected).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(handlers).toHaveLength(1);
    expect(states).toEqual([true, false]);
  });

  it('turns a flags_changed event into its keys; a malformed one drops everything', () => {
    const seen: string[][] = [];
    const stream = new FlagStream({
      open,
      onChange: (k) => void seen.push(k),
      onState: () => {},
    });
    stream.start();
    const h = handlers[0]!;
    h.onMessage('flags_changed', '{"reason":"kill","keys":["a","b"]}');
    h.onMessage('flags_changed', '{"reason":"change","keys":[]}');
    h.onMessage('flags_changed', 'not json');
    h.onMessage('other', '{"keys":["x"]}');
    expect(seen).toEqual([['a', 'b'], [], []]);
    stream.close();
  });
});

describe('flag cache with a stream', () => {
  let server: http.Server;
  let sse: http.ServerResponse[];
  let streamHits: number;
  let streamAuth: string | undefined;
  let evaluateAnswers: Array<Record<string, unknown>>;
  let evaluateHits: number;

  beforeEach(async () => {
    sse = [];
    streamHits = 0;
    evaluateHits = 0;
    evaluateAnswers = [];
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === STREAM_PATH) {
        streamHits++;
        streamAuth = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': hb\n\n');
        sse.push(res);
        return;
      }
      if (req.method === 'POST' && req.url === EVALUATE_PATH) {
        req.resume();
        req.on('end', () => {
          evaluateHits++;
          const answer = evaluateAnswers.shift();
          if (answer === undefined) {
            res.writeHead(503).end('{}');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(answer));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  afterEach(async () => {
    for (const r of sse) r.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function flags() {
    return IntemptFlags.init({
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
      host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
      protocol: 'http',
      logger: testLogger(),
    });
  }

  const ctx = { userId: 'u-1' };
  const served = (value: unknown) => ({
    key: 'k',
    value,
    valueType: 'string',
    variationId: 1,
    reason: 'targeted',
  });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };
  /** The first read starts the stream and is not trusted; the second, made while connected, is cached. */
  const prime = async (c: ReturnType<typeof flags>) => {
    evaluateAnswers.push(served('blue'), served('blue'));
    await c.variation('k', ctx, 'grey');
    await until(() => sse.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    await c.variation('k', ctx, 'grey');
    expect(evaluateHits).toBe(2);
  };
  const event = (data: unknown) =>
    sse[0]!.write(`event: flags_changed\ndata: ${JSON.stringify(data)}\n\n`);

  it('opens one stream with the flag auth and answers repeat reads from the cache', async () => {
    const c = flags();
    await prime(c);
    await expect(c.variation('k', ctx, 'grey')).resolves.toBe('blue');
    await expect(c.variation('k', ctx, 'grey')).resolves.toBe('blue');
    expect(evaluateHits).toBe(2);
    expect(streamHits).toBe(1);
    expect(streamAuth).toMatch(/^Basic /);
    await c.close();
  });

  it('drops the named key at once; the next read asks the server and gets the default for a kill', async () => {
    const c = flags();
    await prime(c);
    evaluateAnswers.push({ key: 'k', value: null, reason: 'killed' });
    event({ reason: 'kill', keys: ['k'] });
    await new Promise((r) => setTimeout(r, 30));
    await expect(c.variationDetail('k', ctx, 'grey')).resolves.toMatchObject({
      value: 'grey',
      reason: 'killed',
    });
    expect(evaluateHits).toBe(3);
    await c.close();
  });

  it('keeps entries for other keys, and keys [] drops every entry', async () => {
    const c = flags();
    await prime(c);
    event({ reason: 'change', keys: ['other'] });
    await new Promise((r) => setTimeout(r, 30));
    await c.variation('k', ctx, 'grey');
    expect(evaluateHits).toBe(2);
    evaluateAnswers.push(served('green'));
    event({ reason: 'change', keys: [] });
    await new Promise((r) => setTimeout(r, 30));
    await expect(c.variation('k', ctx, 'grey')).resolves.toBe('green');
    expect(evaluateHits).toBe(3);
    await c.close();
  });

  it('asks the server every call once the stream is gone, and falls back only on failure', async () => {
    const c = flags();
    await prime(c);
    sse[0]!.destroy();
    await new Promise((r) => setTimeout(r, 30));
    evaluateAnswers.push(served('green'));
    await expect(c.variation('k', ctx, 'grey')).resolves.toBe('green');
    await expect(c.variationDetail('k', ctx, 'grey')).resolves.toMatchObject({
      value: 'green',
      reason: 'cached',
    });
    await c.close();
  });

  it('close() ends the stream and does not reconnect', async () => {
    const c = flags();
    await prime(c);
    await c.close();
    await until(() => sse[0]!.destroyed || sse[0]!.writableEnded);
    await new Promise((r) => setTimeout(r, 1200));
    expect(streamHits).toBe(1);
  });
});
