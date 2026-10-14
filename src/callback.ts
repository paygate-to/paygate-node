import { createHmac, createPublicKey, timingSafeEqual, verify as rsaVerify, type KeyObject } from 'node:crypto';
import { InvalidArgumentError } from './errors.js';
import { PAYGATE_CALLBACK_PUBLIC_KEY_V1 } from './keys.js';
import { PAYGATE_PARAMS, encode, multiplyDecimal, plainDecimal, roundDecimal, safeDecode } from './support.js';

/** Why a callback was rejected. */
export type VerificationFailure =
  | 'signature_absent'
  | 'unknown_key_id'
  | 'bad_public_key'
  | 'signature_not_base64'
  | 'no_registered_callback'
  | 'signature_mismatch';

export interface VerificationResult {
  /** True only when the signature was checked and matches. */
  valid: boolean;
  /** Empty when valid. */
  reason: VerificationFailure | '';
  /** The key the signature was checked against ("v1"), empty if no check took place. */
  keyId: string;
}

/** Looks up a public key PEM for a key id this verifier does not have yet. */
export type KeyResolver = (keyId: string) => string | null | undefined | Promise<string | null | undefined>;

/** The parts of a Node/Express request the SDK reads. */
export interface RequestLike {
  /** Express: the URL before any router rewrote req.url. */
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MISSING_TTL_MS = 10 * 60 * 1000;

/**
 * Checks PayGate.to's RSA signature on a payment callback.
 *
 * The signed string is the callback URL you registered, cut before "?", followed by "?" and the
 * query string exactly as PayGate.to sent it (headers X-PayGate-Signature and X-PayGate-Key-Id).
 * Nothing is rebuilt from parsed parameters. The published key is bundled as "v1".
 *
 *   const result = await paygate.callbacks.verifyRequest('https://shop.example/paygate/callback', req);
 *   if (!result.valid) return res.sendStatus(403);
 */
export class CallbackVerifier {
  private readonly pems = new Map<string, string>();
  private readonly keyObjects = new Map<string, KeyObject>();
  /** key id => time of the last lookup that found nothing; retried after MISSING_TTL_MS. */
  private readonly missing = new Map<string, number>();
  private readonly lookups = new Map<string, Promise<string | null | undefined>>();
  private readonly keyResolver?: KeyResolver;

  /**
   * @param options.keys        key id => PEM. Defaults to the bundled "v1" key.
   * @param options.keyResolver asked for key ids not in `keys`, so a future key works without upgrading.
   *                            Concurrent lookups for one id share a call, and an id the resolver did not
   *                            know is asked again after 10 minutes (so a forged key id cannot block a
   *                            real key that is published later).
   */
  constructor(options: { keys?: Record<string, string>; keyResolver?: KeyResolver } = {}) {
    const keys = options.keys ?? { v1: PAYGATE_CALLBACK_PUBLIC_KEY_V1 };
    for (const [id, pem] of Object.entries(keys)) {
      this.addKey(id, pem);
    }
    this.keyResolver = options.keyResolver;
  }

  /** Adds or replaces a public key. */
  addKey(keyId: string, pem: string): this {
    if (!KEY_ID.test(keyId)) {
      throw new InvalidArgumentError('Key ids are 1 to 32 letters, digits, "_" or "-".');
    }
    if (typeof pem !== 'string' || !pem.includes('-----BEGIN PUBLIC KEY-----')) {
      throw new InvalidArgumentError(`Key "${keyId}" is not a PEM public key.`);
    }
    this.pems.set(keyId, pem);
    this.keyObjects.delete(keyId);
    this.missing.delete(keyId);
    return this;
  }

  /**
   * Verifies a callback.
   *
   * @param registeredCallbackUrl the callback URL you passed when creating the wallet (scheme, host and path are used)
   * @param rawQuery              the query string as received, undecoded (empty when there is none)
   * @param signature             the X-PayGate-Signature header
   * @param keyId                 the X-PayGate-Key-Id header ("v1" when absent)
   */
  async verify(registeredCallbackUrl: string, rawQuery: string | null | undefined, signature: string | null | undefined, keyId?: string | null): Promise<VerificationResult> {
    const sig = String(signature ?? '').trim();
    if (sig === '') {
      return fail('signature_absent');
    }
    const id = String(keyId ?? '').trim() || 'v1';
    const key = await this.keyFor(id);
    if (key === null) {
      return fail('unknown_key_id', id);
    }
    if (key === 'bad') {
      return fail('bad_public_key', id);
    }
    const compact = sig.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) {
      return fail('signature_not_base64', id);
    }
    const base = callbackBase(registeredCallbackUrl);
    if (base === null) {
      return fail('no_registered_callback', id);
    }
    const query = String(rawQuery ?? '').replace(/^\?/, '');
    const signed = query === '' ? base : `${base}?${query}`;
    let ok = false;
    try {
      ok = rsaVerify('sha256', Buffer.from(signed, 'utf8'), key, Buffer.from(compact, 'base64'));
    } catch {
      ok = false;
    }
    return ok ? { valid: true, reason: '', keyId: id } : fail('signature_mismatch', id);
  }

  /** Verifies a Node or Express request: raw query from req.originalUrl (or req.url), headers from req.headers. */
  async verifyRequest(registeredCallbackUrl: string, req: RequestLike): Promise<VerificationResult> {
    return this.verify(registeredCallbackUrl, rawQueryFrom(req), header(req, 'x-paygate-signature'), header(req, 'x-paygate-key-id'));
  }

  private async keyFor(id: string): Promise<KeyObject | 'bad' | null> {
    if (!KEY_ID.test(id)) {
      return null;
    }
    let pem = this.pems.get(id);
    if (pem === undefined && this.keyResolver) {
      const missedAt = this.missing.get(id);
      if (missedAt !== undefined && Date.now() - missedAt < MISSING_TTL_MS) {
        return null;
      }
      let lookup = this.lookups.get(id);
      if (!lookup) {
        lookup = Promise.resolve()
          .then(() => this.keyResolver!(id))
          .catch(() => null)
          .finally(() => this.lookups.delete(id));
        this.lookups.set(id, lookup);
      }
      const resolved = await lookup;
      if (typeof resolved === 'string' && resolved !== '') {
        pem = resolved;
        this.pems.set(id, pem);
        this.missing.delete(id);
      } else {
        if (this.missing.size >= 256) {
          this.missing.delete(this.missing.keys().next().value as string);
        }
        this.missing.set(id, Date.now());
      }
    }
    if (pem === undefined) {
      return null;
    }
    let key = this.keyObjects.get(id);
    if (!key) {
      try {
        key = createPublicKey(pem);
      } catch {
        return 'bad';
      }
      this.keyObjects.set(id, key);
    }
    return key;
  }
}

function fail(reason: VerificationFailure, keyId = ''): VerificationResult {
  return { valid: false, reason, keyId };
}

function header(req: RequestLike, name: string): string | undefined {
  const headers = req.headers ?? {};
  let value = headers[name];
  if (value === undefined) {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    value = key === undefined ? undefined : headers[key];
  }
  return Array.isArray(value) ? value[0] : value;
}

/** The undecoded query string of a request (req.originalUrl, else req.url). */
export function rawQueryFrom(req: RequestLike): string {
  let url = req.originalUrl ?? req.url ?? '';
  const hash = url.indexOf('#');
  if (hash !== -1) {
    url = url.slice(0, hash);
  }
  const mark = url.indexOf('?');
  return mark === -1 ? '' : url.slice(mark + 1);
}

/** Scheme, host, port and path of a URL; null if it is not an absolute http(s) URL. */
export function callbackBase(url: string): string | null {
  const value = String(url ?? '').trim();
  const cut = value.search(/[?#]/);
  const base = cut === -1 ? value : value.slice(0, cut);
  return /^https?:\/\/[^/\s]+/i.test(base) ? base : null;
}

/**
 * The payment data PayGate.to adds to your callback URL. Read it only after the signature is verified.
 *
 * PayGate.to appends its parameters after the ones in your callback URL. When a name appears more
 * than once the last value (PayGate.to's) is used, so a parameter planted in a callback URL cannot
 * override the payment data.
 *
 *   const data = CallbackData.fromRequest(req);
 *   data.valueCoin   // "105.6"
 *   data.txidIn      // credit each payment once
 *   data.payouts()   // { "0x0425...": "96.2148" }
 *   data.get('order')
 */
export class CallbackData {
  constructor(private readonly params: Record<string, string>) {}

  /** Parameters PayGate.to adds; never use these names for your own parameters. */
  static readonly PAYGATE_PARAMS = PAYGATE_PARAMS;

  /** Parses a raw query string: names keep dots, "+" is a space, a repeated name keeps its last value. */
  static fromQueryString(rawQuery: string): CallbackData {
    const params: Record<string, string> = Object.create(null);
    for (const pair of String(rawQuery ?? '').replace(/^\?/, '').split('&')) {
      if (pair === '') {
        continue;
      }
      const eq = pair.indexOf('=');
      const name = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
      params[name] = eq === -1 ? '' : safeDecode(pair.slice(eq + 1));
    }
    return new CallbackData(params);
  }

  /** Reads req.originalUrl (or req.url) of a Node or Express request. */
  static fromRequest(req: RequestLike): CallbackData {
    return CallbackData.fromQueryString(rawQueryFrom(req));
  }

  /** Any parameter, including your own. */
  get(name: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.params, name) ? this.params[name] : undefined;
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.params, name);
  }

  all(): Record<string, string> {
    return { ...this.params };
  }

  /** Amount paid. Card: USDC/USDT after the provider's fee. Crypto: in the paid coin. */
  get valueCoin(): string | undefined {
    return this.get('value_coin');
  }

  /** "polygon_usdc", "btc", "erc20_usdt"... */
  get coin(): string | undefined {
    return this.get('coin');
  }

  /** Transaction that paid the order's address. Key your processing on it so a payment is credited once. */
  get txidIn(): string | undefined {
    return this.get('txid_in');
  }

  /** Transaction that forwarded the funds to your wallet. */
  get txidOut(): string | undefined {
    return this.get('txid_out');
  }

  /** The order's deposit address. */
  get addressIn(): string | undefined {
    return this.get('address_in');
  }

  /** Total forwarded to you (and any affiliates), after fees. */
  get valueForwardedCoin(): string | undefined {
    return this.get('value_forwarded_coin');
  }

  /** True for a crypto payment seen but not yet confirmed. Do not ship goods on it. */
  get pending(): boolean {
    const value = this.get('pending');
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  }

  /** Share of value_forwarded_coin each payout address received (decoded address_out), as plain decimals. */
  get addressOut(): Record<string, string> {
    const json = this.get('address_out');
    if (json === undefined || json === '') {
      return {};
    }
    let decoded: unknown;
    try {
      // Quote bare numbers first so a share is never turned into a float.
      decoded = JSON.parse(json.replace(/([:\[,]\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/g, '$1"$2"'));
    } catch {
      throw new InvalidArgumentError('address_out is not a JSON object.');
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new InvalidArgumentError('address_out is not a JSON object.');
    }
    const shares: Array<[string, string]> = [];
    for (const [address, share] of Object.entries(decoded as Record<string, unknown>)) {
      const plain = typeof share === 'string' ? plainDecimal(share) : undefined;
      if (plain === undefined) {
        throw new InvalidArgumentError(`address_out has a non-numeric share for ${address}.`);
      }
      shares.push([address, plain]);
    }
    return Object.fromEntries(shares);
  }

  /**
   * Exact amount each payout address received: share × value_forwarded_coin, computed without
   * floats. Pass `scale` to round half up to that many decimals.
   */
  payouts(scale?: number): Record<string, string> {
    const forwarded = this.valueForwardedCoin;
    if (forwarded === undefined || plainDecimal(forwarded) === undefined) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(this.addressOut).map(([address, share]) => {
        const amount = multiplyDecimal(forwarded, share);
        return [address, scale === undefined ? amount : roundDecimal(amount, scale)];
      }),
    );
  }

  /** Amount received by one payout address (case-insensitive), undefined if it was not paid. */
  payoutFor(address: string, scale?: number): string | undefined {
    const wanted = address.trim().toLowerCase();
    for (const [payee, amount] of Object.entries(this.payouts(scale))) {
      if (payee.toLowerCase() === wanted) {
        return amount;
      }
    }
    return undefined;
  }
}

/**
 * A secret token in your callback URL, tying each callback to one order, so a payment made to one
 * order's address cannot be replayed against another. Compatible with the PHP SDK's CallbackToken.
 *
 *   const tokens = new CallbackToken(process.env.PAYGATE_CALLBACK_SECRET);
 *   const callback = tokens.callbackUrl('https://shop.example/paygate/callback', { order: '1234' });
 *   tokens.verify(data.get('order'), data.get('token'));
 */
export class CallbackToken {
  private readonly secret: string;
  readonly param: string;

  /**
   * @param secret At least 32 characters, e.g. crypto.randomBytes(32).toString('hex'), kept in your config.
   * @param param  Name of the token parameter (default "token").
   */
  constructor(secret: string | undefined, param = 'token') {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new InvalidArgumentError("The callback secret must be at least 32 characters. Generate one with crypto.randomBytes(32).toString('hex').");
    }
    if (!/^[A-Za-z0-9_]{1,32}$/.test(param) || (PAYGATE_PARAMS as readonly string[]).includes(param)) {
      throw new InvalidArgumentError('The token parameter name may use letters, digits and "_" only.');
    }
    this.secret = secret;
    this.param = param;
  }

  /** HMAC-SHA256 of the order reference, hex encoded. */
  sign(orderRef: string): string {
    if (orderRef === '') {
      throw new InvalidArgumentError('The order reference is empty.');
    }
    return createHmac('sha256', this.secret).update('paygate-order:' + orderRef).digest('hex');
  }

  /** Constant-time check of a token received in a callback. */
  verify(orderRef: string | null | undefined, token: string | null | undefined): boolean {
    if (!orderRef || !token) {
      return false;
    }
    const expected = Buffer.from(this.sign(orderRef));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Your callback URL with the order parameters and the token appended. The first parameter is the signed order reference. */
  callbackUrl(baseUrl: string, params: Record<string, string | number>): string {
    const entries = Object.entries(params ?? {});
    if (entries.some(([name]) => /^\d+$/.test(name))) {
      // JavaScript lists number-like keys first, so the "first" parameter would not be the order reference.
      throw new InvalidArgumentError('Parameter names cannot be plain numbers.');
    }
    if (entries.length === 0) {
      throw new InvalidArgumentError('Pass the order reference, e.g. { order: "1234" }.');
    }
    if (entries.some(([name]) => name === this.param)) {
      throw new InvalidArgumentError(`"${this.param}" is reserved for the token.`);
    }
    const reserved = entries.find(([name]) => (PAYGATE_PARAMS as readonly string[]).includes(name));
    if (reserved) {
      throw new InvalidArgumentError(`"${reserved[0]}" is a parameter PayGate.to adds to the callback; use another name.`);
    }
    entries.push([this.param, this.sign(String(entries[0][1]))]);
    const query = entries.map(([name, value]) => `${encode(name)}=${encode(String(value))}`).join('&');
    return baseUrl + (baseUrl.includes('?') ? '&' : '?') + query;
  }
}
