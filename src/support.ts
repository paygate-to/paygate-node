import { InvalidArgumentError } from './errors.js';

/** Parameters PayGate.to adds to the callback URL; never use these names for your own parameters. */
export const PAYGATE_PARAMS = ['value_coin', 'coin', 'txid_in', 'txid_out', 'address_in', 'value_forwarded_coin', 'address_out', 'pending'] as const;

/** decodeURIComponent with "+" as a space, keeping invalid escapes as they are (like PHP's urldecode). */
export function safeDecode(part: string): string {
  const text = part.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** An amount: a number or a decimal string such as "49.90". */
export type Amount = number | string;

/** Plain positive decimal string ("12.5", never "1.25e+1" or "1,234.50"). */
export function formatAmount(value: Amount, label = 'Amount'): string {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidArgumentError(`${label} must be a finite number.`);
    }
    // Like the PHP SDK: floats are rounded to 8 decimals, so 0.1 + 0.2 is sent as 0.3.
    text = Math.abs(value) < 1e15 ? value.toFixed(8).replace(/\.?0+$/, '') : plainNumber(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new InvalidArgumentError(`${label} must be a number.`);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new InvalidArgumentError(`${label} "${text}" must be a plain positive number such as 49.90.`);
  }
  if (!(Number(text) > 0)) {
    throw new InvalidArgumentError(`${label} must be greater than zero.`);
  }
  return text;
}

/** Numbers from the API as plain decimal strings (1e-5 becomes "0.00001"). */
export function plainNumber(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value);
    if (!/e/i.test(text)) {
      return text;
    }
    if (Number.isInteger(value)) {
      return BigInt(value).toString();
    }
    return value.toFixed(20).replace(/\.?0+$/, '');
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return '';
}

/** Map of currency => plain number string, keys upper-cased. */
export function stringMap(map: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') {
        out[key.toUpperCase()] = plainNumber(value);
      }
    }
  }
  return out;
}

/** "https://api-shop-1a2b.paygate.to/" -> "api-shop-1a2b.paygate.to". */
export function normaliseHost(value: string, label: string): string {
  let host = String(value).trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split('/')[0].replace(/\.+$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new InvalidArgumentError(`${label} "${value}" is not a valid host name.`);
  }
  return host;
}

/** A wallet address: non-empty, no spaces. Its format is checked by PayGate.to. */
export function validateWallet(value: string, label: string): string {
  const wallet = String(value ?? '').trim();
  if (wallet === '' || /\s/.test(wallet)) {
    throw new InvalidArgumentError(`${label} is empty or contains spaces.`);
  }
  return wallet;
}

/** An absolute http(s) callback URL with at least one query parameter (the order reference). */
export function validateCallback(url: string): string {
  const value = String(url ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError('The callback URL must be an absolute http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidArgumentError('The callback URL must be an absolute http(s) URL.');
  }
  if (parsed.search.length <= 1) {
    throw new InvalidArgumentError('The callback URL needs at least one parameter unique to the order, e.g. ?order=1234.');
  }
  for (const pair of parsed.search.slice(1).split('&')) {
    const name = safeDecode(pair.split('=')[0]);
    if ((PAYGATE_PARAMS as readonly string[]).includes(name)) {
      throw new InvalidArgumentError(`The callback URL must not contain "${name}": PayGate.to adds that parameter itself.`);
    }
  }
  return value;
}

/** A share of the payout below 1 ("0.01" for 1%). */
export function validateShare(value: Amount | null | undefined, label: string): string {
  if (value === null || value === undefined) {
    throw new InvalidArgumentError(`${label} is required.`);
  }
  const text = formatAmount(value, label);
  if (Number(text) >= 1) {
    throw new InvalidArgumentError(`${label} is a share: use 0.01 for 1%.`);
  }
  return text;
}

/** PayGate.to keeps 1%, so the shares must add up to exactly 0.99. */
export function assertShares(shares: string[]): void {
  const total = shares.reduce((sum, share) => sum + Math.round(Number(share) * 10000), 0);
  if (total !== 9900) {
    const shown = (total / 10000).toFixed(4).replace(/\.?0+$/, '');
    throw new InvalidArgumentError(`The shares add up to ${shown}; they must add up to exactly 0.99 (PayGate.to keeps 1%).`);
  }
}

/** wallet => share for mass payouts: 1 to 19 wallets totalling 0.99. */
export function validateShares(shares: Record<string, Amount>): Record<string, number> {
  const entries = Object.entries(shares ?? {});
  if (entries.length === 0 || entries.length > 19) {
    throw new InvalidArgumentError('Give between 1 and 19 payout wallets.');
  }
  const out: Record<string, number> = {};
  for (const [wallet, share] of entries) {
    out[validateWallet(wallet, 'Payout wallet')] = Number(validateShare(share, `Share of ${wallet}`));
  }
  assertShares(Object.values(out).map(String));
  return out;
}

/** White-label options of the hosted pages. */
export interface Branding {
  /** Your white-label checkout domain. */
  domain?: string;
  /** URL of your logo. */
  logo?: string;
  /** Page background: hex or CSS colour name. */
  background?: string;
  /** Accent colour: hex or CSS colour name. */
  theme?: string;
  /** Button colour: hex or CSS colour name. */
  button?: string;
}

const BRANDING_KEYS = ['domain', 'logo', 'background', 'theme', 'button'] as const;

export function validateBranding(branding: Branding | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(branding ?? {})) {
    if (!(BRANDING_KEYS as readonly string[]).includes(name)) {
      throw new InvalidArgumentError(`Unknown branding option "${name}". Use: ${BRANDING_KEYS.join(', ')}.`);
    }
    if (raw === undefined || raw === null) {
      continue;
    }
    let value = String(raw).trim();
    if (value === '') {
      continue;
    }
    if (name === 'domain') {
      value = normaliseHost(value, 'Branding domain');
    }
    out[name] = value;
  }
  return out;
}

/** encodeURIComponent plus the characters it leaves alone that PHP's rawurlencode encodes. */
export function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * PayGate.to returns some values already percent-encoded (address_in, payment_token, ipn_token).
 * A value made only of unreserved characters and %XX escapes is passed through unchanged;
 * anything else is encoded, so "&" or "=" can never add a parameter.
 */
export function keepEncoded(value: string): string {
  return /%[0-9A-Fa-f]{2}/.test(value) && /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/.test(value) ? value : encode(value);
}

export type QueryValue = string | number | null | undefined;

/** "?a=1&b=2", skipping empty values. Names in `raw` are already encoded by PayGate.to. */
export function queryString(query: Record<string, QueryValue>, raw: string[] = []): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const text = String(value);
    parts.push(encode(name) + '=' + (raw.includes(name) ? keepEncoded(text) : encode(text)));
  }
  return parts.length === 0 ? '' : '?' + parts.join('&');
}

/**
 * A non-negative decimal string: "0.05", "1e-7" and "1.5E+3" become "0.05", "0.0000001", "1500".
 * Undefined when the text is not a number.
 */
export function plainDecimal(text: string): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(text).trim());
  if (!match) {
    return undefined;
  }
  let int = match[1];
  let frac = match[2] ?? '';
  const exp = match[3] ? parseInt(match[3], 10) : 0;
  if (exp > 0) {
    frac = frac.padEnd(exp, '0');
    int += frac.slice(0, exp);
    frac = frac.slice(exp);
  } else if (exp < 0) {
    int = int.padStart(-exp + 1, '0');
    frac = int.slice(exp) + frac;
    int = int.slice(0, exp);
  }
  return buildDecimal(int, frac);
}

/** Exact product of two non-negative decimal strings. */
export function multiplyDecimal(a: string, b: string): string {
  const x = plainDecimal(a);
  const y = plainDecimal(b);
  if (x === undefined || y === undefined) {
    throw new InvalidArgumentError(`"${a}" × "${b}" is not a product of decimal numbers.`);
  }
  const [xi, xf = ''] = x.split('.');
  const [yi, yf = ''] = y.split('.');
  const decimals = xf.length + yf.length;
  const digits = (BigInt(xi + xf) * BigInt(yi + yf)).toString().padStart(decimals + 1, '0');
  return buildDecimal(digits.slice(0, digits.length - decimals), decimals > 0 ? digits.slice(-decimals) : '');
}

/** Rounds a non-negative decimal string half up to `scale` decimals. */
export function roundDecimal(value: string, scale: number): string {
  const plain = plainDecimal(value);
  if (plain === undefined || !Number.isInteger(scale) || scale < 0) {
    throw new InvalidArgumentError(`Cannot round "${value}" to ${scale} decimals.`);
  }
  const [int, frac = ''] = plain.split('.');
  if (frac.length <= scale) {
    return plain;
  }
  let kept = BigInt(int + frac.slice(0, scale));
  if (frac[scale] >= '5') {
    kept += 1n;
  }
  const digits = kept.toString().padStart(scale + 1, '0');
  return buildDecimal(digits.slice(0, digits.length - scale), scale > 0 ? digits.slice(-scale) : '');
}

function buildDecimal(int: string, frac: string): string {
  const i = int.replace(/^0+/, '');
  const f = frac.replace(/0+$/, '');
  return (i === '' ? '0' : i) + (f === '' ? '' : '.' + f);
}
