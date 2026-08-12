/*
    The agent/proxy setup and the response-classification shape are adapted from
    mixpanel-node (lib/mixpanel-node.js send_request),
    Copyright (c) 2012 Carl Sverre, released under the MIT license.
    See NOTICE.

    The transport itself is not inherited: Intempt takes a JSON POST body and a
    Basic Authorization header, not a base64 query string.
*/

import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ApiKeyCredentials } from './credentials';
import type { ResolvedConfig } from './types';
import { LIB_HEADER, LIB_NAME, LIB_VERSION } from './stamp';

/** A non-2xx response, or a transport failure with no response at all. */
export class IntemptApiError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    detail: { status?: number; body?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'IntemptApiError';
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.body !== undefined) this.body = detail.body;
    if (detail.retryAfterMs !== undefined) this.retryAfterMs = detail.retryAfterMs;
    if (detail.cause !== undefined) this.cause = detail.cause;
  }

  /** True for statuses worth retrying: 408, 429, and any 5xx. */
  get retryable(): boolean {
    if (this.status === undefined) return true; // transport error or timeout
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface TransportResponse<T = unknown> {
  status: number;
  body: T;
  raw: string;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

/**
 * Owns the sockets and the credential. One instance per client, so keep-alive
 * agents and the cached Basic value are reused across every request.
 */
export class Transport {
  #config: ResolvedConfig;
  readonly #credentials: ApiKeyCredentials;
  readonly #agents: { http: http.Agent; https: https.Agent };
  readonly #proxyAgent: HttpsProxyAgent<string> | null;

  constructor(config: ResolvedConfig, credentials: ApiKeyCredentials) {
    this.#config = config;
    this.#credentials = credentials;

    const keepAlive = config.keepAlive;
    this.#agents = {
      http: new http.Agent({ keepAlive }),
      https: new https.Agent({ keepAlive }),
    };

    const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    this.#proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive }) : null;
  }

  setConfig(config: ResolvedConfig): void {
    this.#config = config;
  }

  /** `/v1/{org}/projects/{project}` plus the given suffix. */
  projectPath(suffix: string): string {
    const { path, org, project } = this.#config;
    return `${path}/v1/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}${suffix}`;
  }

  async post<T = unknown>(path: string, body: unknown): Promise<TransportResponse<T>> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const lib = this.#agents[this.#config.protocol];
    const requestLib = this.#config.protocol === 'https' ? https : http;

    if (this.#config.debug) {
      this.#config.logger.debug('[intempt] POST', path, body);
    }

    const options: http.RequestOptions = {
      host: this.#config.host,
      method: 'POST',
      path,
      agent: this.#proxyAgent ?? lib,
      timeout: this.#config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.byteLength,
        Authorization: this.#credentials.toAuthorizationHeader(),
        [LIB_HEADER]: `${LIB_NAME}/${LIB_VERSION}`,
      },
    };
    if (this.#config.port !== undefined) {
      options.port = this.#config.port;
    }

    return new Promise<TransportResponse<T>>((resolve, reject) => {
      const request = requestLib.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            const retryAfterMs = parseRetryAfter(
              res.headers['retry-after'] as string | undefined,
            );
            reject(
              new IntemptApiError(`Intempt API responded ${status}`, {
                status,
                body: raw,
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
              }),
            );
            return;
          }

          let parsed: unknown = undefined;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({ status, body: parsed as T, raw });
        });
      });

      request.on('timeout', () => {
        request.destroy(
          new IntemptApiError(`Intempt API request timed out after ${this.#config.timeout}ms`),
        );
      });

      request.on('error', (error: unknown) => {
        if (error instanceof IntemptApiError) {
          reject(error);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        reject(new IntemptApiError(`Intempt API request failed: ${message}`, { cause: error }));
      });

      request.write(payload);
      request.end();
    });
  }

  /** Releases keep-alive sockets so a process can exit promptly. */
  destroy(): void {
    this.#agents.http.destroy();
    this.#agents.https.destroy();
  }
}
