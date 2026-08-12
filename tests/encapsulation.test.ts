import { describe, expect, it } from 'vitest';
import { SDK } from '../src';
import { API_KEY, ORG, PROJECT, SOURCE, client, setupNock } from './helpers';

setupNock();

/**
 * TypeScript's `private` is erased at compile time, so a `private readonly`
 * field is a public JS property. Before this suite existed,
 * `client.transport.credentials.toHttpBasicAuth()` returned the Basic value,
 * which base64-decodes straight back to the API secret. Every internal is now a
 * true `#private` field; these tests fail loudly if one is ever demoted.
 */

const PUBLIC_METHODS = [
  'track',
  'trackBatch',
  'identify',
  'group',
  'alias',
  'optIn',
  'optOut',
  'isOptedIn',
  'flush',
  'close',
  'setConfig',
];
const PUBLIC_GETTERS = ['config', 'buffered'];
const PUBLIC_NAMESPACES = ['consent', 'ecommerce', 'decide'];

function prototypeNames(value: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value))
    .filter((name) => name !== 'constructor')
    .sort();
}

describe('the client exposes exactly the agreed surface', () => {
  const c = client();

  it('has only the agreed prototype members', () => {
    expect(prototypeNames(c)).toEqual([...PUBLIC_METHODS, ...PUBLIC_GETTERS].sort());
  });

  it('has only the three namespaces as own properties', () => {
    expect(Object.keys(c).sort()).toEqual([...PUBLIC_NAMESPACES].sort());
  });

  it('exposes no transport, credential, batcher or ingest', () => {
    for (const leaked of ['transport', 'credentials', 'batcher', 'batcherInstance', 'ingest']) {
      expect(c, leaked).not.toHaveProperty(leaked);
      expect((c as unknown as Record<string, unknown>)[leaked], leaked).toBeUndefined();
    }
  });

  it('exposes no mutable opt-out or closed flag', () => {
    // Writing `client.optedIn = true` must not be able to defeat optOut().
    const escape = c as unknown as Record<string, unknown>;
    expect(escape.optedIn).toBeUndefined();
    expect(escape.closed).toBeUndefined();

    c.optOut();
    escape.optedIn = true;
    escape.closed = false;
    expect(c.isOptedIn()).toBe(false);
  });

  it('exposes no resolved config object to mutate', () => {
    expect((c as unknown as Record<string, unknown>).resolved).toBeUndefined();
  });
});

describe('config() hands back a frozen snapshot', () => {
  it('cannot be mutated to redirect traffic', () => {
    const c = client();
    const snapshot = c.config;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as unknown as Record<string, unknown>).host = 'evil.example.com';
    }).toThrow(TypeError);
    expect(c.config.host).toBe('api.test.local');
  });

  it('returns a new object each read, so a stale reference cannot leak later state', () => {
    const c = client();
    expect(c.config).not.toBe(c.config);
    expect(c.config).toEqual(c.config);
  });
});

describe('namespaces expose no internals', () => {
  const c = client();

  it('consent exposes only grant and revoke', () => {
    expect(prototypeNames(c.consent)).toEqual(['grant', 'revoke']);
    expect((c.consent as unknown as Record<string, unknown>).deps).toBeUndefined();
    expect(Object.keys(c.consent)).toEqual([]);
  });

  it('ecommerce exposes only the three commerce calls and no ingest handle', () => {
    expect(prototypeNames(c.ecommerce)).toEqual(['addedToCart', 'ordered', 'productViewed']);
    expect((c.ecommerce as unknown as Record<string, unknown>).ingest).toBeUndefined();
    expect(Object.keys(c.ecommerce)).toEqual([]);
  });

  it('decide exposes only experiences and recommend', () => {
    expect(prototypeNames(c.decide)).toEqual(['experiences', 'recommend']);
    expect((c.decide as unknown as Record<string, unknown>).deps).toBeUndefined();
    expect(Object.keys(c.decide)).toEqual([]);
  });
});

describe('the legacy shim exposes no client handle', () => {
  it('offers v2 as the only way through', () => {
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    expect((sdk as unknown as Record<string, unknown>).client).toBeUndefined();
    expect(Object.keys(sdk)).toEqual([]);
    expect(typeof sdk.v2.track).toBe('function');
  });
});

describe('the credential is unreachable from the public graph', () => {
  it('cannot be walked to from the client', () => {
    const c = client();
    const seen = new Set<unknown>();
    let found = false;

    const walk = (value: unknown, depth: number): void => {
      if (found || depth > 4 || value === null || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);

      for (const key of Object.keys(value as object)) {
        const child = (value as Record<string, unknown>)[key];
        if (typeof child === 'object' && child !== null) {
          const candidate = child as { toHttpBasicAuth?: unknown };
          if (typeof candidate.toHttpBasicAuth === 'function') {
            found = true;
            return;
          }
          walk(child, depth + 1);
        }
      }
    };

    walk(c, 0);
    expect(found).toBe(false);
  });

  it('does not serialise into JSON.stringify of the client', () => {
    const c = client();
    expect(JSON.stringify(c)).not.toContain('sec0123456789abcdef');
    expect(JSON.stringify(c)).not.toContain(
      Buffer.from('pfx0123456789abcdef:sec0123456789abcdef').toString('base64'),
    );
  });
});
