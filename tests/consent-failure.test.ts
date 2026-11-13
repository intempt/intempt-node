import { describe, expect, it } from 'vitest';
import { CONSENT_PATH, ORIGIN, client, nock, setupNock, testLogger } from './helpers';

setupNock();

/**
 * Ro-bot mcp-1794565555-8 security:F1, rulings R2/R3: a consent failure is reported, never thrown
 * and never silent. grant/revoke resolve false, fire onDeliveryFailure once with the delivery shape
 * and log at error. Consent shares the send-once policy of track (CONTRACT-R2 §S1).
 */

type Failure = {
  kind: string;
  status?: number;
  eventCount: number;
  eventIds: string[];
  retryAfter?: number;
  terminal: boolean;
};

function withListener() {
  const failures: Failure[] = [];
  const logger = testLogger();
  const c = client({
    logger,
    onDeliveryFailure: (f: Failure) => failures.push(f),
  } as never);
  return { c, failures, logger };
}

function consentServer(
  replies: Array<
    number | { status: number; headers: Record<string, string> } | 'refused'
  >,
) {
  let hits = 0;
  for (const reply of replies) {
    const scope = nock(ORIGIN).post(CONSENT_PATH, () => {
      hits += 1;
      return true;
    });
    if (reply === 'refused') {
      scope.replyWithError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    } else if (typeof reply === 'number') {
      scope.reply(reply, '');
    } else {
      scope.reply(reply.status, '', reply.headers);
    }
  }
  return { hits: () => hits };
}

describe('consent failure is reported, never thrown, never silent (R2)', () => {
  it('a granted consent resolves true and reports nothing', async () => {
    consentServer([200]);
    const { c, failures, logger } = withListener();

    await expect(c.consent.grant({ userId: 'u1' })).resolves.toBe(true);
    expect(failures).toEqual([]);
    expect(logger.calls.error).toEqual([]);
  });

  it('a revoke answered 500 resolves false, fires the listener once and logs at error', async () => {
    const server = consentServer([500, 200]);
    const { c, failures, logger } = withListener();

    await expect(c.consent.revoke({ userId: 'u1' })).resolves.toBe(false);
    expect(server.hits()).toBe(1);
    expect(failures).toEqual([
      { kind: 'terminal', status: 500, eventCount: 1, eventIds: [], terminal: true },
    ]);
    expect(logger.calls.error.length).toBe(1);
    expect(String(logger.calls.error[0]![0])).toContain('consent delivery failed');
  });

  it('a grant that never reached the server resolves false and is reported dropped', async () => {
    consentServer(['refused']);
    const { c, failures, logger } = withListener();

    await expect(c.consent.grant({ userId: 'u1' })).resolves.toBe(false);
    expect(failures).toEqual([
      { kind: 'dropped', eventCount: 1, eventIds: [], terminal: true },
    ]);
    expect(logger.calls.error.length).toBe(1);
  });

  it('a bad argument and a closed client still reject', async () => {
    const { c } = withListener();
    await expect(c.consent.revoke({} as never)).rejects.toThrow(TypeError);
    await c.close();
    await expect(c.consent.grant({ userId: 'u1' })).rejects.toThrow(/client is closed/);
  });
});

describe('consent follows send-once (R3)', () => {
  it('429 with Retry-After is resent once and resolves true on success', async () => {
    const server = consentServer([{ status: 429, headers: { 'Retry-After': '1' } }, 200]);
    const { c, failures } = withListener();

    await expect(c.consent.grant({ userId: 'u1' })).resolves.toBe(true);
    expect(server.hits()).toBe(2);
    expect(failures).toEqual([]);
  });

  it('503 twice resolves false after exactly one resend, reported terminal', async () => {
    const server = consentServer([503, 503, 200]);
    const { c, failures } = withListener();

    await expect(c.consent.revoke({ userId: 'u1' })).resolves.toBe(false);
    expect(server.hits()).toBe(2);
    expect(failures.map((f) => [f.kind, f.status, f.terminal])).toEqual([
      ['terminal', 503, true],
    ]);
  });

  it('400 is not resent', async () => {
    const server = consentServer([400, 200]);
    const { c } = withListener();

    await expect(c.consent.grant({ userId: 'u1' })).resolves.toBe(false);
    expect(server.hits()).toBe(1);
  });
});
