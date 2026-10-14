import { CallbackVerifier, type KeyResolver } from './callback.js';
import { CardApi } from './card.js';
import { CryptoApi } from './crypto.js';
import { InvalidArgumentError } from './errors.js';
import { Requester, type FetchLike } from './http.js';
import { normaliseHost } from './support.js';

export const VERSION = '1.0.0';
export const DEFAULT_API_DOMAIN = 'api.paygate.to';
export const DEFAULT_CHECKOUT_DOMAIN = 'checkout.paygate.to';

export interface PayGateOptions {
  /** Host for API calls. Default api.paygate.to; use your free dedicated endpoint in production. */
  apiDomain?: string;
  /** Host of the hosted payment pages. Default checkout.paygate.to, or your white-label domain. */
  checkoutDomain?: string;
  /** Milliseconds before a request is abandoned (default 30000). */
  timeoutMs?: number;
  /** Extra attempts for GET requests that fail at the network level (default 1). POST is never retried. */
  retries?: number;
  /** Your own fetch implementation (default: the global fetch of Node 18+). */
  fetch?: FetchLike;
  /** Overrides the User-Agent header. */
  userAgent?: string;
  /** Keys and key resolver for `paygate.callbacks` (default: the bundled "v1" key). */
  callbacks?: { keys?: Record<string, string>; keyResolver?: KeyResolver };
}

const KNOWN = ['apiDomain', 'checkoutDomain', 'timeoutMs', 'retries', 'fetch', 'userAgent', 'callbacks'];

/**
 * Entry point of the PayGate.to Node.js SDK.
 *
 *   import { PayGate } from 'paygate-to';
 *   const paygate = new PayGate();                                          // shared api.paygate.to
 *   const paygate = new PayGate({ apiDomain: 'api-myshop-1a2b3c.paygate.to' }); // your dedicated endpoint
 *
 *   paygate.card        // card payments, payouts in USDC
 *   paygate.crypto      // crypto payments with a QR code on your site, or the hosted multi-coin page
 *   paygate.callbacks   // verify PayGate.to's signature on payment confirmations
 */
export class PayGate {
  readonly card: CardApi;
  readonly crypto: CryptoApi;
  readonly callbacks: CallbackVerifier;
  readonly apiDomain: string;
  readonly checkoutDomain: string;

  constructor(options: PayGateOptions = {}) {
    const unknown = Object.keys(options).filter((key) => !KNOWN.includes(key));
    if (unknown.length > 0) {
      throw new InvalidArgumentError(`Unknown option(s): ${unknown.join(', ')}. Known options: ${KNOWN.join(', ')}.`);
    }
    this.apiDomain = normaliseHost(options.apiDomain || DEFAULT_API_DOMAIN, 'apiDomain');
    this.checkoutDomain = normaliseHost(options.checkoutDomain || DEFAULT_CHECKOUT_DOMAIN, 'checkoutDomain');

    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (typeof fetchImpl !== 'function') {
      throw new InvalidArgumentError('No fetch implementation: use Node.js 18 or newer, or pass options.fetch.');
    }
    const timeoutMs = options.timeoutMs ?? 30000;
    const retries = options.retries ?? 1;
    if (!(timeoutMs > 0) || timeoutMs > 2147483647) {
      throw new InvalidArgumentError('timeoutMs must be between 1 and 2147483647.');
    }
    if (!Number.isInteger(retries) || retries < 0) {
      throw new InvalidArgumentError('retries must be a whole number, 0 or more.');
    }

    const requester = new Requester({
      apiHost: this.apiDomain,
      userAgent: options.userAgent || `paygate-node/${VERSION}`,
      retries,
      timeoutMs,
      fetch: fetchImpl,
    });
    this.card = new CardApi(requester, this.checkoutDomain);
    this.crypto = new CryptoApi(requester, this.checkoutDomain);
    this.callbacks = new CallbackVerifier(options.callbacks ?? {});
  }
}
