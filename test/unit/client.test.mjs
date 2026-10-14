import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, CallbackVerifier, InvalidArgumentError, PayGate, TransportError } from '../../dist/esm/index.js';
import { FakeFetch } from '../helpers.mjs';

test('defaults', () => {
  const client = new PayGate({ fetch: new FakeFetch().fetch });
  assert.equal(client.apiDomain, 'api.paygate.to');
  assert.equal(client.checkoutDomain, 'checkout.paygate.to');
  assert.ok(client.callbacks instanceof CallbackVerifier);
});

test('dedicated domains are normalised', () => {
  const client = new PayGate({ apiDomain: 'https://API-MyShop-1a2b.paygate.to/', checkoutDomain: 'pay.example.com', fetch: new FakeFetch().fetch });
  assert.equal(client.apiDomain, 'api-myshop-1a2b.paygate.to');
  assert.equal(client.checkoutDomain, 'pay.example.com');
});

test('unknown option, bad host and bad numbers are rejected', () => {
  assert.throws(() => new PayGate({ api_domain: 'x' }), /api_domain/);
  assert.throws(() => new PayGate({ apiDomain: 'not a host' }), InvalidArgumentError);
  assert.throws(() => new PayGate({ apiDomain: 'evil.example@paygate.to' }), InvalidArgumentError);
  assert.throws(() => new PayGate({ retries: -1 }), InvalidArgumentError);
  assert.throws(() => new PayGate({ timeoutMs: 0 }), InvalidArgumentError);
});

test('requests use https, accept JSON, send the user agent and never follow redirects', async () => {
  const http = new FakeFetch().respond({ coin: 'Bitcoin', minimum: '0.0001', prices: { USD: '60000' } });
  await new PayGate({ fetch: http.fetch }).crypto.info('btc');
  assert.equal(http.last.url, 'https://api.paygate.to/crypto/btc/info.php');
  assert.equal(http.last.method, 'GET');
  assert.equal(http.last.redirect, 'manual');
  assert.equal(http.last.headers.Accept, 'application/json');
  assert.match(http.last.headers['User-Agent'], /^paygate-node\//);
});

test('GET is retried once on network failure', async () => {
  const http = new FakeFetch().fail().respond({ coin: 'Bitcoin', minimum: '1', prices: {} });
  const info = await new PayGate({ fetch: http.fetch }).crypto.info('btc');
  assert.equal(info.coin, 'Bitcoin');
  assert.equal(http.requests.length, 2);
});

test('retries can be disabled', async () => {
  const http = new FakeFetch().fail('getaddrinfo ENOTFOUND');
  await assert.rejects(new PayGate({ fetch: http.fetch, retries: 0 }).crypto.info('btc'), (e) => e instanceof TransportError && /ENOTFOUND/.test(e.message));
});

test('POST is never retried', async () => {
  const http = new FakeFetch().fail();
  await assert.rejects(
    new PayGate({ fetch: http.fetch }).crypto.createHostedWallet({ btc: 'bc1qexample' }, 10, 'USD', 'https://shop.example/cb?order=1'),
    TransportError,
  );
  assert.equal(http.requests.length, 1);
});

test('timeouts abort the request', async () => {
  const http = new FakeFetch().hang();
  await assert.rejects(new PayGate({ fetch: http.fetch, timeoutMs: 50, retries: 0 }).crypto.info('btc'), /timed out after 50 ms/);
});

for (const [name, body, status] of [
  ['http 500', '{"status":"error","message":"down"}', 500],
  ['status error', '{"status":"error","message":"invalid wallet"}', 200],
  ['not json', '<html>Bad gateway</html>', 200],
  ['redirect', '', 302],
]) {
  test(`error response: ${name}`, async () => {
    const http = new FakeFetch().respond(body, status);
    await assert.rejects(new PayGate({ fetch: http.fetch }).crypto.info('btc'), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.statusCode, status);
      assert.equal(e.responseBody, body);
      return true;
    });
  });
}

test('API error messages are surfaced, query strings are not', async () => {
  const http = new FakeFetch().respond({ status: 'error', message: 'Invalid payout wallet' });
  await assert.rejects(new PayGate({ fetch: http.fetch }).card.createWallet('0xabc', 'https://shop.example/cb?order=1&token=secret'), (e) => {
    assert.match(e.message, /Invalid payout wallet/);
    assert.doesNotMatch(e.message, /secret|0xabc/);
    assert.equal(e.url, 'https://api.paygate.to/control/wallet.php');
    return true;
  });
});

test('network error messages never carry the query string', async () => {
  const leaky = async (url) => { throw new Error(`request to ${url} failed, reason: connect ECONNREFUSED`); };
  await assert.rejects(new PayGate({ fetch: leaky, retries: 0 }).card.createWallet('0xabc', 'https://shop.example/cb?order=1&token=SECRETTOKEN'), (e) => {
    assert.ok(e instanceof TransportError);
    assert.doesNotMatch(e.message, /SECRETTOKEN|0xabc|\?/);
    return true;
  });
});

test('timeoutMs must be a usable timer value', () => {
  assert.throws(() => new PayGate({ timeoutMs: Infinity }), InvalidArgumentError);
  assert.throws(() => new PayGate({ timeoutMs: 2 ** 31 }), InvalidArgumentError);
});

test('callback keys can be set on the client', async () => {
  const client = new PayGate({ callbacks: { keys: {} } });
  assert.equal((await client.callbacks.verify('https://x.example/cb', 'a=1', 'c2ln', 'v1')).reason, 'unknown_key_id');
});

test('errors share a base class', async () => {
  const { PayGateError } = await import('../../dist/esm/index.js');
  assert.ok(new ApiError('x') instanceof PayGateError);
  assert.ok(new InvalidArgumentError('x') instanceof PayGateError);
  assert.equal(new ApiError('x').name, 'ApiError');
});
