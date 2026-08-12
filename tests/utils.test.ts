import { describe, expect, it } from 'vitest';
import { assertIdentifier, assertLogger, chunk, compact, ensureTimestamp } from '../src/utils';

describe('assertLogger', () => {
  it('accepts console', () => {
    expect(() => assertLogger(console)).not.toThrow();
  });

  it.each(['trace', 'debug', 'info', 'warn', 'error'])(
    'rejects a logger missing %s',
    (missing) => {
      const logger: Record<string, unknown> = {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };
      delete logger[missing];
      expect(() => assertLogger(logger)).toThrow(new RegExp(`missing "${missing}"`));
    },
  );

  it('rejects null and primitives', () => {
    expect(() => assertLogger(null)).toThrow(/valid Logger/);
    expect(() => assertLogger(42)).toThrow(/valid Logger/);
  });
});

describe('ensureTimestamp', () => {
  it('passes epoch milliseconds through', () => {
    expect(ensureTimestamp(1_767_322_445_000)).toBe(1_767_322_445_000);
  });

  it('converts a Date', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(ensureTimestamp(date)).toBe(date.getTime());
  });

  it('accepts 0', () => {
    expect(ensureTimestamp(0)).toBe(0);
  });

  it.each([
    ['an invalid Date', new Date('nope')],
    ['a string', '1767322445000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => ensureTimestamp(value as never)).toThrow(TypeError);
  });
});

describe('chunk', () => {
  it('splits evenly with a remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when the size exceeds the length', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns nothing for an empty array', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('rejects a size below one, which would loop forever', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('assertIdentifier', () => {
  it.each([
    { userId: 'u1' },
    { profileId: 'p1' },
    { accountId: 'a1' },
    { userId: 'u1', accountId: 'a1' },
  ])('accepts %j', (ids) => {
    expect(() => assertIdentifier(ids, 'test')).not.toThrow();
  });

  it('rejects an empty object and blank strings', () => {
    expect(() => assertIdentifier({}, 'test')).toThrow(/one of userId/);
    expect(() => assertIdentifier({ userId: '' }, 'test')).toThrow(/one of userId/);
  });

  it('names the calling method in the error', () => {
    expect(() => assertIdentifier({}, 'recommend')).toThrow(/^recommend:/);
  });
});

describe('compact', () => {
  it('drops undefined but keeps null, 0 and empty string', () => {
    expect(compact({ a: undefined, b: null, c: 0, d: '', e: false })).toEqual({
      b: null,
      c: 0,
      d: '',
      e: false,
    });
  });
});
