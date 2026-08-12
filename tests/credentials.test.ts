import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ApiKeyCredentials } from '../src';

const KEY = 'pfx0123456789abcdef.sec0123456789abcdef';
const EXPECTED = Buffer.from('pfx0123456789abcdef:sec0123456789abcdef').toString('base64');

describe('ApiKeyCredentials: parsing', () => {
  it('splits <prefix>.<secret> and encodes Basic auth', () => {
    const creds = new ApiKeyCredentials(KEY);
    expect(creds.prefix).toBe('pfx0123456789abcdef');
    expect(creds.toHttpBasicAuth()).toBe(EXPECTED);
    expect(creds.toAuthorizationHeader()).toBe(`Basic ${EXPECTED}`);
  });

  it('trims surrounding whitespace', () => {
    expect(new ApiKeyCredentials(`  ${KEY}  `).toHttpBasicAuth()).toBe(EXPECTED);
  });

  it('caches the encoding rather than recomputing it', () => {
    const creds = new ApiKeyCredentials(KEY);
    expect(creds.toHttpBasicAuth()).toBe(creds.toHttpBasicAuth());
  });

  it.each([
    ['no separator', 'nodotshere'],
    ['two separators', 'a.b.c'],
    ['empty prefix', '.secret'],
    ['empty secret', 'prefix.'],
  ])('rejects a malformed key: %s', (_label, key) => {
    expect(() => new ApiKeyCredentials(key)).toThrow(TypeError);
  });

  it('rejects an empty or non-string key', () => {
    expect(() => new ApiKeyCredentials('')).toThrow(/cannot be empty/);
    expect(() => new ApiKeyCredentials('   ')).toThrow(/cannot be empty/);
    expect(() => new ApiKeyCredentials(undefined as never)).toThrow(/must be a string/);
  });

  it('reports how many separators it found', () => {
    expect(() => new ApiKeyCredentials('a.b.c')).toThrow(/found 2/);
  });
});

describe('ApiKeyCredentials: secret never leaks', () => {
  const creds = new ApiKeyCredentials(KEY);

  it('masks the secret in toString', () => {
    expect(creds.toString()).toBe(
      'ApiKeyCredentials(prefix=pfx0123456789abcdef, secret=***)',
    );
    expect(creds.toString()).not.toContain('sec0123456789abcdef');
  });

  it('masks the secret in util.inspect, which is what console.log uses', () => {
    expect(inspect(creds)).not.toContain('sec0123456789abcdef');
  });

  it('masks the secret in JSON.stringify', () => {
    expect(JSON.stringify(creds)).not.toContain('sec0123456789abcdef');
    expect(JSON.parse(JSON.stringify(creds))).toEqual({
      prefix: 'pfx0123456789abcdef',
      secret: '***',
    });
  });

  it('keeps the secret out of own enumerable properties', () => {
    // 1.x logged the whole axios error, whose config.url carried ?apiKey=.
    const dumped = JSON.stringify({ wrapped: creds, error: new Error('boom').message });
    expect(dumped).not.toContain('sec0123456789abcdef');
  });
});
