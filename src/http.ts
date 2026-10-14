import { ApiError, InvalidArgumentError, TransportError } from './errors.js';
import { queryString, type QueryValue } from './support.js';

/** Minimal fetch signature, so any WHATWG-compatible fetch can be passed in. */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'manual' | 'follow' | 'error';
  // AbortSignal; typed loosely so the declarations need neither the DOM lib nor @types/node.
  signal?: any;
}) => Promise<{ status: number; text(): Promise<string> }>;

/** @internal */
export interface RequesterOptions {
  apiHost: string;
  userAgent: string;
  retries: number;
  timeoutMs: number;
  fetch: FetchLike;
}

/** @internal Sends API requests and decodes the JSON answers. */
export class Requester {
  constructor(private readonly options: RequesterOptions) {}

  get apiHost(): string {
    return this.options.apiHost;
  }

  url(path: string, query: Record<string, QueryValue> = {}, raw: string[] = []): string {
    return `https://${this.options.apiHost}/${path.replace(/^\/+/, '')}${queryString(query, raw)}`;
  }

  /** GET, retried on network failures unless `retry` is false (requests that are not safe to repeat). */
  async get(path: string, query: Record<string, QueryValue> = {}, raw: string[] = [], retry = true): Promise<Record<string, any>> {
    const url = this.url(path, query, raw);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send('GET', url);
      } catch (error) {
        if (!(error instanceof TransportError) || !retry || attempt >= this.options.retries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  /** POST a JSON body. Never retried, so a payment is never created twice. */
  async postJson(path: string, payload: Record<string, unknown>, query: Record<string, QueryValue> = {}): Promise<Record<string, any>> {
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      throw new InvalidArgumentError('The request body could not be encoded as JSON.');
    }
    return this.send('POST', this.url(path, query), body);
  }

  private async send(method: string, url: string, body?: string): Promise<Record<string, any>> {
    const redacted = redact(url);
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.options.userAgent };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.options.fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
      status = response.status;
      text = await response.text();
    } catch (error) {
      const reason = controller.signal.aborted ? `timed out after ${this.options.timeoutMs} ms` : describe(error);
      throw new TransportError(`Request to ${redacted} failed: ${reason}`, error);
    } finally {
      clearTimeout(timer);
    }
    return decode(status, text, redacted);
  }
}

function decode(status: number, body: string, url: string): Record<string, any> {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    data = undefined;
  }
  const isObject = data !== null && typeof data === 'object';
  if (status < 200 || status >= 300) {
    const message = isObject ? errorMessage(data as Record<string, unknown>) : '';
    throw new ApiError(`PayGate.to answered HTTP ${status} for ${url}${message ? ': ' + message : '.'}`, status, body, url);
  }
  if (!isObject) {
    throw new ApiError(`PayGate.to returned a response that is not JSON for ${url}.`, status, body, url);
  }
  const record = data as Record<string, any>;
  if (typeof record.status === 'string' && record.status.toLowerCase() === 'error') {
    const message = errorMessage(record);
    throw new ApiError(`PayGate.to reported an error for ${url}${message ? ': ' + message : '.'}`, status, body, url);
  }
  return record;
}

function errorMessage(data: Record<string, unknown>): string {
  for (const key of ['message', 'error', 'detail']) {
    const value = data[key];
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return '';
}

function describe(error: unknown): string {
  let text = String(error);
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    text = cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  // Some fetch implementations quote the request URL: drop every query string (wallets, callback tokens).
  return text.replace(/(https?:\/\/[^\s?()"']*)\?[^\s()"']*/gi, '$1');
}

/** Drop the query string from URLs placed in error messages (it holds wallets and callbacks). */
function redact(url: string): string {
  const pos = url.indexOf('?');
  return pos === -1 ? url : url.slice(0, pos);
}
