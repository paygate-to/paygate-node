import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { CallbackData, CallbackToken, CallbackVerifier, InvalidArgumentError, PAYGATE_CALLBACK_PUBLIC_KEY_V1, callbackBase, rawQueryFrom } from '../../dist/esm/index.js';

const REGISTERED = 'https://www.example.com/orders.php?number=827746841326';
const QUERY = 'number=827746841326&value_coin=105.6&coin=polygon_usdc&txid_in=0xa22a82b4aefbc55f6382e1b5c0b4f0e3c034a654df3bcac431f7fed1942e22bc&txid_out=0x94c2c3e84c2021e6bf377aebf8abf03b49570611bb0c336e357d7f4516f56244&address_in=0x32e854bD1270670C832634CA87858fFd9F3e2c78&value_forwarded_coin=104.016&address_out=%7B%220x34653D12778FccF10eE978EfFb16450258d2aFc9%22%3A%220.0500%22%2C%220x042beb6Ab05814c3A54C4124e368a30c4f7c93FB%22%3A%220.9250%22%7D';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const signWith = (data, key = privateKey) => sign('sha256', Buffer.from(data), key).toString('base64');
const verifier = () => new CallbackVerifier({ keys: { v1: PEM } });
const SIG = signWith('https://www.example.com/orders.php?' + QUERY);

test('valid signature', async () => {
  assert.deepEqual(await verifier().verify(REGISTERED, QUERY, SIG, 'v1'), { valid: true, reason: '', keyId: 'v1' });
  assert.equal((await verifier().verify(REGISTERED, QUERY, SIG)).valid, true, 'no key id means v1');
  assert.equal((await verifier().verify(REGISTERED, '?' + QUERY, SIG)).valid, true, 'leading ? is ignored');
});

test('altered amount, host or path is rejected', async () => {
  const forged = QUERY.replace('value_coin=105.6', 'value_coin=1056');
  assert.equal((await verifier().verify(REGISTERED, forged, SIG)).reason, 'signature_mismatch');
  assert.equal((await verifier().verify('https://evil.example/orders.php', QUERY, SIG)).reason, 'signature_mismatch');
  assert.equal((await verifier().verify('https://www.example.com/other.php', QUERY, SIG)).reason, 'signature_mismatch');
});

test('the raw query is used, never a rebuilt one', async () => {
  const query = 'order=A%20B&note=%7bx%7d&value_coin=1';
  const sig = signWith('https://shop.example/cb?' + query);
  assert.equal((await verifier().verify('https://shop.example/cb?order=A%20B', query, sig)).valid, true);
  const rebuilt = new URLSearchParams({ order: 'A B', note: '{x}', value_coin: '1' }).toString();
  assert.equal((await verifier().verify('https://shop.example/cb', rebuilt, sig)).valid, false);
});

test('signature from another key is rejected', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const sig = signWith('https://www.example.com/orders.php?' + QUERY, other);
  assert.equal((await verifier().verify(REGISTERED, QUERY, sig)).reason, 'signature_mismatch');
});

for (const [name, sig, keyId, registered, reason] of [
  ['no header', undefined, 'v1', REGISTERED, 'signature_absent'],
  ['empty header', '  ', 'v1', REGISTERED, 'signature_absent'],
  ['unknown key', 'c2ln', 'v9', REGISTERED, 'unknown_key_id'],
  ['path traversal key id', 'c2ln', '../v1', REGISTERED, 'unknown_key_id'],
  ['not base64', '***', 'v1', REGISTERED, 'signature_not_base64'],
  ['relative callback', 'c2ln', 'v1', '/orders.php', 'no_registered_callback'],
  ['empty callback', 'c2ln', 'v1', '', 'no_registered_callback'],
  ['garbage signature', 'c2lnbmF0dXJl', 'v1', REGISTERED, 'signature_mismatch'],
]) {
  test(`fails closed: ${name}`, async () => {
    const result = await verifier().verify(registered, QUERY, sig, keyId);
    assert.equal(result.valid, false);
    assert.equal(result.reason, reason);
  });
}

test('bad public key', async () => {
  const v = new CallbackVerifier({ keys: { v1: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' } });
  assert.equal((await v.verify(REGISTERED, QUERY, SIG)).reason, 'bad_public_key');
});

test('unknown key ids are resolved once', async () => {
  let calls = 0;
  const v = new CallbackVerifier({ keys: {}, keyResolver: () => { calls++; return null; } });
  for (let i = 0; i < 5; i++) {
    await v.verify(REGISTERED, QUERY, 'c2ln', 'forged');
  }
  assert.equal(calls, 1);
});

test('a forged key id does not block a key published later, and lookups are shared', async () => {
  let published = false;
  let calls = 0;
  const v = new CallbackVerifier({ keys: {}, keyResolver: async (id) => { calls++; await new Promise((r) => setTimeout(r, 5)); return published && id === 'v2' ? PEM : null; } });
  await Promise.all(Array.from({ length: 20 }, () => v.verify(REGISTERED, QUERY, 'AAAA', 'v2')));
  assert.equal(calls, 1, 'concurrent lookups share one call');
  published = true;
  v.addKey('v2', PEM); // or: wait for the 10-minute retry
  assert.equal((await v.verify(REGISTERED, QUERY, SIG, 'v2')).valid, true);
});

test('headers are matched case-insensitively and unpadded base64 is accepted', async () => {
  const headers = { 'X-PayGate-Signature': SIG.replace(/=+$/, ''), 'X-PayGate-Key-Id': 'v1' };
  assert.equal((await verifier().verifyRequest(REGISTERED, { url: '/orders.php?' + QUERY, headers })).valid, true);
});

test('only one leading ? and a missing query', async () => {
  assert.equal((await verifier().verify(REGISTERED, '??' + QUERY, SIG)).valid, false);
  assert.equal((await verifier().verify('https://shop.example/cb', null, signWith('https://shop.example/cb'))).valid, true);
});

test('key resolver handles rotation and is cached', async () => {
  const asked = [];
  const v = new CallbackVerifier({ keys: {}, keyResolver: async (id) => { asked.push(id); return id === 'v2' ? PEM : null; } });
  assert.equal((await v.verify(REGISTERED, QUERY, SIG, 'v2')).valid, true);
  assert.equal((await v.verify(REGISTERED, QUERY, SIG, 'v2')).valid, true);
  assert.equal((await v.verify(REGISTERED, QUERY, SIG, 'v3')).reason, 'unknown_key_id');
  assert.deepEqual(asked, ['v2', 'v3']);
});

test('bundled key is the published key', async () => {
  assert.equal(createHash('md5').update(PAYGATE_CALLBACK_PUBLIC_KEY_V1).digest('hex'), 'e6a0d8bf66a5d2f9bbdf6a9c9ca694c0');
  assert.equal((await new CallbackVerifier().verify(REGISTERED, QUERY, SIG, 'v1')).reason, 'signature_mismatch');
});

test('verifyRequest reads Express and plain Node requests', async () => {
  const headers = { 'x-paygate-signature': SIG, 'x-paygate-key-id': 'v1' };
  assert.equal((await verifier().verifyRequest(REGISTERED, { originalUrl: '/orders.php?' + QUERY, url: '/?rewritten', headers })).valid, true);
  assert.equal((await verifier().verifyRequest(REGISTERED, { url: '/orders.php?' + QUERY, headers })).valid, true);
  assert.equal((await verifier().verifyRequest(REGISTERED, { url: '/orders.php?' + QUERY, headers: {} })).reason, 'signature_absent');
});

test('rawQueryFrom and callbackBase', () => {
  assert.equal(rawQueryFrom({ url: '/cb?a=1&b=%20#frag', headers: {} }), 'a=1&b=%20');
  assert.equal(rawQueryFrom({ url: '/cb', headers: {} }), '');
  assert.equal(callbackBase(' https://shop.example:8443/pay/cb?order=1#x '), 'https://shop.example:8443/pay/cb');
  assert.equal(callbackBase('ftp://shop.example/cb'), null);
});

test('addKey validation', () => {
  assert.throws(() => new CallbackVerifier({ keys: {} }).addKey('v1', 'not a key'), InvalidArgumentError);
  assert.throws(() => new CallbackVerifier({ keys: {} }).addKey('bad id!', PEM), InvalidArgumentError);
});

test('CallbackData: documented example', () => {
  const data = CallbackData.fromQueryString(QUERY);
  assert.equal(data.get('number'), '827746841326');
  assert.equal(data.valueCoin, '105.6');
  assert.equal(data.coin, 'polygon_usdc');
  assert.equal(data.valueForwardedCoin, '104.016');
  assert.equal(data.pending, false);
  assert.deepEqual(data.addressOut, { '0x34653D12778FccF10eE978EfFb16450258d2aFc9': '0.05', '0x042beb6Ab05814c3A54C4124e368a30c4f7c93FB': '0.925' });
  // 0.0500 × 104.016 = 5.2008 and 0.9250 × 104.016 = 96.2148
  assert.deepEqual(data.payouts(), { '0x34653D12778FccF10eE978EfFb16450258d2aFc9': '5.2008', '0x042beb6Ab05814c3A54C4124e368a30c4f7c93FB': '96.2148' });
  assert.equal(data.payoutFor('0x042BEB6AB05814C3A54C4124E368A30C4F7C93FB'), '96.2148');
  assert.equal(data.payoutFor('0xnobody'), undefined);
});

test('CallbackData: parser keeps dots, last value, decodes + and bad escapes', () => {
  const data = CallbackData.fromQueryString('?my.order=5&a=1&a=2&name=J%C3%B6rg+M&flag&bad=%ZZ%41&__proto__=x');
  assert.equal(data.get('my.order'), '5');
  assert.equal(data.get('a'), '2');
  assert.equal(data.get('name'), 'Jörg M');
  assert.equal(data.get('flag'), '');
  assert.equal(data.get('bad'), '%ZZA');
  assert.equal(data.get('__proto__'), 'x');
  assert.equal(data.get('toString'), undefined);
  assert.equal(data.get('missing'), undefined);
});

test('CallbackData: pending values', () => {
  assert.equal(CallbackData.fromQueryString('pending=1').pending, true);
  assert.equal(CallbackData.fromQueryString('pending=0').pending, false);
  assert.equal(CallbackData.fromQueryString('pending=false').pending, false);
  assert.equal(CallbackData.fromQueryString('coin=btc').pending, false);
});

test('CallbackData: planted parameters cannot override PayGate data', () => {
  const data = CallbackData.fromQueryString('order=123&value_coin=5000&coin=erc20_usdc&pending=0&value_coin=1.00&coin=erc20_usdt&pending=1');
  assert.equal(data.valueCoin, '1.00');
  assert.equal(data.coin, 'erc20_usdt');
  assert.equal(data.pending, true);
});

test('CallbackData: exact payouts', () => {
  const data = CallbackData.fromQueryString('value_forwarded_coin=0.123456789012345678&address_out=' + encodeURIComponent('{"0xA":"0.925","0xB":0.05,"0xC":1e-7}'));
  assert.deepEqual(data.addressOut, { '0xA': '0.925', '0xB': '0.05', '0xC': '0.0000001' });
  assert.deepEqual(data.payouts(), { '0xA': '0.11419752983641975215', '0xB': '0.0061728394506172839', '0xC': '0.0000000123456789012345678' });
  assert.equal(data.payouts(8)['0xA'], '0.11419753');
  const doc = CallbackData.fromQueryString('value_forwarded_coin=0.0000053781&address_out=' + encodeURIComponent('{"0x1":"0.0500"}'));
  assert.equal(doc.payoutFor('0x1'), '0.000000268905');
  assert.equal(doc.payoutFor('0x1', 8), '0.00000027');
});

test('CallbackData: numeric shares stay exact and odd addresses are kept', () => {
  const data = CallbackData.fromQueryString('value_forwarded_coin=1&address_out=' + encodeURIComponent('{"0xA":0.12345678901234567891,"__proto__":0.5}'));
  assert.equal(data.addressOut['0xA'], '0.12345678901234567891');
  assert.equal(Object.keys(data.payouts()).length, 2);
  assert.equal(Object.getOwnPropertyDescriptor(data.payouts(), '__proto__').value, '0.5');
});

test('CallbackData: missing or invalid address_out', () => {
  assert.deepEqual(CallbackData.fromQueryString('value_forwarded_coin=1').payouts(), {});
  assert.throws(() => CallbackData.fromQueryString('address_out=%7Bbroken').addressOut, InvalidArgumentError);
  assert.throws(() => CallbackData.fromQueryString('address_out=' + encodeURIComponent('{"0xA":"abc"}')).addressOut, InvalidArgumentError);
});

test('CallbackData.fromRequest', () => {
  const data = CallbackData.fromRequest({ originalUrl: '/cb?order=9&value_coin=0.001', headers: {} });
  assert.deepEqual(data.all(), { order: '9', value_coin: '0.001' });
});

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';

test('CallbackToken round trip', () => {
  const tokens = new CallbackToken(SECRET);
  const url = tokens.callbackUrl('https://shop.example/cb', { order: 'A 1', lang: 'en' });
  assert.match(url, /^https:\/\/shop\.example\/cb\?order=A%201&lang=en&token=[0-9a-f]{64}$/);
  const data = CallbackData.fromQueryString(new URL(url).search);
  assert.equal(tokens.verify(data.get('order'), data.get('token')), true);
  assert.equal(tokens.verify('A 2', data.get('token')), false);
  assert.equal(tokens.verify(data.get('order'), undefined), false);
  assert.equal(tokens.verify(data.get('order'), 'short'), false);
  assert.equal(new CallbackToken(SECRET.split('').reverse().join('')).verify(data.get('order'), data.get('token')), false);
});

test('CallbackToken matches the PHP SDK', () => {
  // hash_hmac('sha256', 'paygate-order:1234', SECRET) computed by the PHP SDK
  assert.equal(new CallbackToken(SECRET).sign('1234'), 'e15683918d6429225ff4c99a0253aefb2104d4f9c4b31d22989c6acbbe88e29d');
});

test('CallbackToken validation', () => {
  assert.throws(() => new CallbackToken('short'), InvalidArgumentError);
  assert.throws(() => new CallbackToken(undefined), InvalidArgumentError);
  assert.throws(() => new CallbackToken(SECRET).callbackUrl('https://s.example/cb', { token: 'x' }), /reserved/);
  assert.throws(() => new CallbackToken(SECRET).callbackUrl('https://s.example/cb', {}), InvalidArgumentError);
  assert.throws(() => new CallbackToken(SECRET).callbackUrl('https://s.example/cb', { order: 1, value_coin: 5000 }), /PayGate\.to adds/);
  assert.throws(() => new CallbackToken(SECRET).callbackUrl('https://s.example/cb', { order: 'A', 5: 'B' }), /plain numbers/);
  assert.match(new CallbackToken(SECRET, 'sig').callbackUrl('https://s.example/cb?x=1', { order: 5 }), /^https:\/\/s\.example\/cb\?x=1&order=5&sig=/);
});
