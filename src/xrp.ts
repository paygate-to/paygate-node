import { createHash } from 'node:crypto';

/*
 * XRP Ledger payout addresses.
 *
 * PayGate.to accepts an XRP payout wallet as a classic address ("r…"), a classic address with a
 * destination tag ("r…?dt=777") or an X-address ("X…", which carries the tag). In the callback's
 * address_out it always writes the classic form: "r…?dt=777", or "r…" when there is no tag.
 * xrpPayoutForm() turns your wallet into that form so you can compare the two.
 */

const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
/** Mainnet X-address prefix (XLS-5d). */
const X_PREFIX = [0x05, 0x44];

/** A decoded mainnet X-address. */
export interface XrpXAddress {
  classic: string;
  /** Destination tag, null when the X-address has none. */
  tag: number | null;
}

/**
 * The form PayGate.to uses in address_out: an X-address becomes "r…?dt=TAG" ("r…" without a
 * tag). Any other value is returned trimmed and unchanged.
 */
export function xrpPayoutForm(address: string): string {
  const trimmed = address.trim();
  const decoded = decodeXrpXAddress(trimmed);
  if (!decoded) {
    return trimmed;
  }
  return decoded.tag === null ? decoded.classic : `${decoded.classic}?dt=${decoded.tag}`;
}

/** Decode a mainnet X-address; undefined if the value is not one. */
export function decodeXrpXAddress(address: string): XrpXAddress | undefined {
  const text = address.trim();
  if (text.length < 40 || text.length > 50 || text[0] !== 'X') {
    return undefined;
  }
  const bytes = base58Decode(text);
  if (!bytes || bytes.length !== 35) {
    return undefined;
  }
  const payload = bytes.subarray(0, 31);
  if (!checksum(payload).equals(bytes.subarray(31))) {
    return undefined;
  }
  if (payload[0] !== X_PREFIX[0] || payload[1] !== X_PREFIX[1]) {
    return undefined;
  }
  const flag = payload[22];
  const tagBytes = payload.subarray(23, 31);
  let tag: number | null;
  if (flag === 0 && tagBytes.every((b) => b === 0)) {
    tag = null;
  } else if (flag === 1 && tagBytes.subarray(4).every((b) => b === 0)) {
    tag = tagBytes.readUInt32LE(0);
  } else {
    return undefined;
  }
  const versioned = Buffer.concat([Buffer.from([0]), payload.subarray(2, 22)]);
  return { classic: base58Encode(Buffer.concat([versioned, checksum(versioned)])), tag };
}

function checksum(data: Buffer): Buffer {
  const once = createHash('sha256').update(data).digest();
  return createHash('sha256').update(once).digest().subarray(0, 4);
}

function base58Decode(text: string): Buffer | undefined {
  const digits: number[] = []; // little-endian, base 256
  for (const char of text) {
    let carry = ALPHABET.indexOf(char);
    if (carry < 0) {
      return undefined;
    }
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === ALPHABET[0]) {
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(digits.reverse())]);
}

function base58Encode(bytes: Buffer): string {
  const digits: number[] = []; // little-endian, base 58
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    out += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    out += ALPHABET[digits[i]];
  }
  return out;
}
