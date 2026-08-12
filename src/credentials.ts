/*
    Adapted from mixpanel-node (lib/credentials.js ServiceAccountCredentials),
    Copyright (c) 2012 Carl Sverre, released under the MIT license.
    See NOTICE.
*/

/**
 * An Intempt API key, in `<prefix>.<secret>` form.
 *
 * The base64 Basic-auth value is computed once and cached; the secret is masked
 * in `toString()` so an accidental log or error dump cannot leak it.
 */
export class ApiKeyCredentials {
  readonly prefix: string;
  private readonly cachedBasic: string;

  constructor(apiKey: string) {
    if (typeof apiKey !== 'string') {
      throw new TypeError('API key must be a string');
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new TypeError('API key cannot be empty');
    }

    const separators = trimmed.split('.').length - 1;
    if (separators !== 1) {
      throw new TypeError(
        `Malformed API key: expected exactly one "." separator, found ${separators}`,
      );
    }

    const [prefix, secret] = trimmed.split('.') as [string, string];
    if (!prefix || !secret) {
      throw new TypeError('Malformed API key: both prefix and secret are required');
    }

    this.prefix = prefix;
    this.cachedBasic = Buffer.from(`${prefix}:${secret}`).toString('base64');
  }

  /** The value for an `Authorization: Basic <...>` header. */
  toHttpBasicAuth(): string {
    return this.cachedBasic;
  }

  /** The full `Authorization` header value. */
  toAuthorizationHeader(): string {
    return `Basic ${this.cachedBasic}`;
  }

  toString(): string {
    return `ApiKeyCredentials(prefix=${this.prefix}, secret=***)`;
  }

  /** Keeps the secret out of `console.log`, `util.inspect` and error dumps. */
  toJSON(): { prefix: string; secret: string } {
    return { prefix: this.prefix, secret: '***' };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}
