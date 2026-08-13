import { describe, expect, it } from 'vitest';
import { Intempt } from '../src';
import {
  API_KEY,
  HOST,
  ORG,
  ORIGIN,
  PROJECT,
  SOURCE,
  TRACK_PATH,
  client,
  nock,
  setupNock,
} from './helpers';

setupNock();

/**
 * Validation and coercion boundaries, each derived from a mutant that survived on
 * CI. These are the checks that decide whether bad input is rejected at init or
 * carried silently onto the wire, so a rewrite that nothing notices is the
 * difference between a loud TypeError and a request addressed to the wrong place.
 */

describe('a platform id is never put through Number()', () => {
  it('sends a 19-digit sourceId in the path exactly as given', async () => {
    // The rule that produced this test: Number('1841710181319290880') rounds to
    // 1841710181319290900, which addresses a different source. Nothing in the
    // suite pinned the coercion, so `String(...)` could have become `Number(...)`
    // unnoticed.
    const snowflake = '1841710181319290880';
    let path: string | undefined;
    nock(ORIGIN)
      .post(`/v1/${ORG}/projects/${PROJECT}/sources/${snowflake}/track`)
      .reply(200, function () {
        path = this.req.path;
        return '';
      });

    await client({ sourceId: snowflake }).track('purchase', { userId: 'u1' });

    expect(path).toContain(snowflake);
    // The decisive assertion: the digits survive intact rather than rounding.
    expect(path).not.toContain('1841710181319290900');
  });

  it('rejects a sourceId that is only whitespace', async () => {
    // `String(x).trim() === ''` catches this; dropping the trim does not.
    expect(() =>
      Intempt.init({ org: ORG, project: PROJECT, apiKey: API_KEY, sourceId: '   ' }),
    ).toThrow(/"sourceId" must not be empty when provided/);
  });

  it('omits sourceId from the resolved config when it was not provided', async () => {
    // A key present with an undefined value reads as "configured to nothing",
    // which is not the same as absent, and the track path branches on it.
    const c = client({ sourceId: undefined });
    expect(Object.keys(c.config)).not.toContain('sourceId');
  });
});

describe('init rejects a config that is not an object', () => {
  it.each([
    ['null', null],
    ['a string', 'org/project'],
    ['a number', 42],
  ])('rejects %s with a message naming the requirement', (_label, value) => {
    // A check of "falsy AND not an object" is satisfied by nothing, so every one
    // of these would sail through and fail later with an unrelated error.
    expect(() => Intempt.init(value as never)).toThrow(
      /Intempt\.init requires a config object/,
    );
  });

  it.each(['org', 'project', 'apiKey'])('names %s when it is missing', (field) => {
    const base: Record<string, unknown> = {
      org: ORG,
      project: PROJECT,
      apiKey: API_KEY,
    };
    delete base[field];
    expect(() => Intempt.init(base as never)).toThrow(
      new RegExp(`Intempt\\.init: "${field}" is required`),
    );
  });
});

describe('a port embedded in host is validated, not assumed', () => {
  it('rejects port 0, which is not a port a client can connect to', () => {
    // `parsed <= 0` catches it; `parsed < 0` does not, and 0 would then be passed
    // to http.request as a real port.
    expect(() => client({ host: `${HOST}:0` })).toThrow(/invalid port in host/);
  });

  it('rejects a non-numeric and a fractional port', () => {
    expect(() => client({ host: `${HOST}:abc` })).toThrow(/invalid port in host/);
    expect(() => client({ host: `${HOST}:80.5` })).toThrow(/invalid port in host/);
  });

  it('accepts a real port and carries it into the resolved config', () => {
    const c = client({ host: `${HOST}:8443` });
    expect(c.config.host).toBe(HOST);
    expect(c.config.port).toBe(8443);
  });

  it('omits port entirely when the host carries none', () => {
    const c = client({ host: HOST });
    expect(Object.keys(c.config)).not.toContain('port');
  });
});

describe('setConfig boundaries', () => {
  it('clears a previously configured port when the new host has none', () => {
    // Leaving the old port in place would send the next request to
    // new-host:8443, a host/port pair the caller never asked for.
    const c = client({ host: `${HOST}:8443` });
    expect(c.config.port).toBe(8443);

    c.setConfig({ host: 'other.test.local' });
    expect(c.config.host).toBe('other.test.local');
    expect(c.config.port).toBeUndefined();
  });

  it('keeps the new port when the new host carries one', () => {
    const c = client({ host: `${HOST}:8443` });
    c.setConfig({ host: 'other.test.local:9000' });
    expect(c.config.port).toBe(9000);
  });

  it('rejects a timeout of 0, not merely a negative one', () => {
    // `<= 0` catches it; `< 0` lets 0 through, and a 0ms timeout aborts every
    // request immediately.
    const c = client();
    expect(() => c.setConfig({ timeout: 0 })).toThrow(
      /timeout must be a positive number of milliseconds/,
    );
    expect(() => c.setConfig({ timeout: -1 })).toThrow(RangeError);
    expect(() => c.setConfig({ timeout: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    // Unchanged by the rejected patches.
    expect(c.config.timeout).toBe(10_000);
  });

  it('tells the caller where a construction-fixed option belongs', () => {
    // The second half of the sentence is the actionable half; without it the
    // error says "no" and not "do this instead".
    const c = client();
    for (const field of ['keepAlive', 'agent'] as const) {
      expect(() => c.setConfig({ [field]: true } as never)).toThrow(
        new RegExp(
          `setConfig: "${field}" is fixed at construction because the HTTP agents are ` +
            `built once\\. Pass it to Intempt\\.init instead\\.`,
        ),
      );
    }
  });

  it('accepts both supported protocols and rejects anything else', () => {
    const c = client();
    expect(() => c.setConfig({ protocol: 'http' })).not.toThrow();
    expect(c.config.protocol).toBe('http');
    expect(() => c.setConfig({ protocol: 'https' })).not.toThrow();
    expect(c.config.protocol).toBe('https');
    expect(() => c.setConfig({ protocol: 'ftp' } as never)).toThrow(
      /unsupported protocol "ftp"/,
    );
  });
});

describe('an explicit timestamp is validated', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '2026-01-01'],
    ['an invalid Date', new Date('nope')],
  ])('rejects %s with the same message', async (_label, value) => {
    await expect(
      client().track('purchase', { userId: 'u1', timestamp: value as never }),
    ).rejects.toThrow(/`timestamp` must be a valid Date or epoch milliseconds/);
  });

  it('accepts a Date and sends its epoch milliseconds', async () => {
    const when = new Date('2026-08-13T12:00:00.000Z');
    let body: { track: Array<{ payload: Array<{ timestamp: number }> }> } | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH, (b) => {
        body = b as typeof body;
        return true;
      })
      .reply(200, '');

    await client().track('purchase', { userId: 'u1', timestamp: when });
    expect(body!.track[0]!.payload[0]!.timestamp).toBe(when.getTime());
  });

  it('accepts epoch milliseconds unchanged', async () => {
    let body: { track: Array<{ payload: Array<{ timestamp: number }> }> } | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH, (b) => {
        body = b as typeof body;
        return true;
      })
      .reply(200, '');

    await client().track('purchase', { userId: 'u1', timestamp: 1_760_000_000_000 });
    expect(body!.track[0]!.payload[0]!.timestamp).toBe(1_760_000_000_000);
  });
});

describe('undefined values are dropped rather than serialised', () => {
  it('omits an explicitly undefined option from the wire payload', async () => {
    // JSON.stringify already drops undefined at the top level, but these values
    // are assembled into an object first, and a key present with undefined would
    // survive into nested structures and into any non-JSON transport later.
    let body: { track: Array<{ payload: Array<Record<string, unknown>> }> } | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH, (b) => {
        body = b as typeof body;
        return true;
      })
      .reply(200, '');

    await client().track('purchase', {
      userId: 'u1',
      accountId: undefined,
      properties: undefined,
      userAttributes: undefined,
    });

    const item = body!.track[0]!.payload[0]!;
    expect(item.userId).toBe('u1');
    for (const key of ['accountId', 'data', 'userAttributes']) {
      expect(Object.keys(item)).not.toContain(key);
    }
  });

  it('keeps a value that is legitimately null or empty', async () => {
    // Only undefined is dropped. null and '' are values the caller chose.
    let body:
      { track: Array<{ payload: Array<{ data: Record<string, unknown> }> }> } | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH, (b) => {
        body = b as typeof body;
        return true;
      })
      .reply(200, '');

    await client().track('purchase', {
      userId: 'u1',
      properties: { cleared: null, blank: '', zero: 0, no: false },
    });

    const data = body!.track[0]!.payload[0]!.data;
    expect(data).toEqual({ cleared: null, blank: '', zero: 0, no: false });
  });
});

describe('the error type identifies itself', () => {
  it('reports name as IntemptApiError, which is what callers match on', async () => {
    nock(ORIGIN).post(TRACK_PATH).reply(500, 'boom');
    const error = (await client()
      .track('purchase', { userId: 'u1' })
      .catch((e: unknown) => e)) as Error;
    expect(error.name).toBe('IntemptApiError');
    // toString() derives from name, so this is the string a log line shows.
    expect(String(error)).toMatch(/^IntemptApiError: /);
  });
});

describe('chunk refuses a size that cannot make progress', () => {
  it('rejects 0 and negatives through the public maxRequestEvents path', async () => {
    // A size of 0 makes the loop never advance, so this has to be rejected rather
    // than clamped.
    expect(() => client({ maxRequestEvents: 0 })).toThrow();
    expect(() => client({ maxRequestEvents: -5 })).toThrow();
  });

  it('splits a batch at exactly maxRequestEvents', async () => {
    const widths: number[] = [];
    nock(ORIGIN)
      .post(TRACK_PATH, (b: { track: unknown[] }) => {
        widths.push(b.track.length);
        return true;
      })
      .times(4)
      .reply(200, '');

    await client({ maxRequestEvents: 2 }).trackBatch(
      Array.from({ length: 5 }, (_, i) => ({ event: `e${i}`, userId: 'u1' })),
    );

    expect(widths.reduce((a, b) => a + b, 0)).toBe(5);
    expect(Math.max(...widths)).toBe(2);
  });
});

describe('the deprecated shim still resolves the same config', () => {
  it('carries org, project and sourceId through to the wire', async () => {
    const { SDK } = await import('../src');
    let path: string | undefined;
    nock(ORIGIN)
      .post(TRACK_PATH)
      .reply(200, function () {
        path = this.req.path;
        return '';
      });

    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ host: HOST });
    await sdk.v2.track('purchase', { userId: 'u1' });

    expect(path).toBe(TRACK_PATH);
    await sdk.close();
  });
});
