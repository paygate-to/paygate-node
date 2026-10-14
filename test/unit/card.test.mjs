import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ApiError, InvalidArgumentError, PayGate } from '../../dist/esm/index.js';
import { FakeFetch } from '../helpers.mjs';

const WALLET = '0x34653D12778FccF10eE978EfFb16450258d2aFc9';
const CALLBACK = 'https://shop.example/paygate/callback?order=1001&token=ab cd';
const ADDRESS_IN = 'iZUo%2B5jQ%2FhpVvBEc%3D%3D';
const walletResponse = {
  address_in: ADDRESS_IN,
  polygon_address_in: '0x32e854bD1270670C832634CA87858fFd9F3e2c78',
  callback_url: CALLBACK,
  ipn_token: 'ZEE2cW8z%3D',
};
const rawurlencode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

let http;
let card;
beforeEach(() => {
  http = new FakeFetch();
  card = new PayGate({ fetch: http.fetch }).card;
});

test('createWallet encodes the callback once', async () => {
  http.respond(walletResponse);
  const wallet = await card.createWallet(WALLET, CALLBACK);
  assert.equal(http.lastPath, '/control/wallet.php');
  assert.equal(http.lastQuery, `address=${WALLET}&callback=${rawurlencode(CALLBACK)}`);
  assert.equal(wallet.addressIn, ADDRESS_IN);
  assert.equal(wallet.polygonAddressIn, '0x32e854bD1270670C832634CA87858fFd9F3e2c78');
  assert.equal(wallet.ipnToken, 'ZEE2cW8z%3D');
});

test('callback validation', async () => {
  await assert.rejects(card.createWallet(WALLET, 'https://shop.example/callback'), /\?order=1234/);
  await assert.rejects(card.createWallet(WALLET, '/callback?order=1'), InvalidArgumentError);
  await assert.rejects(card.createWallet(WALLET, 'ftp://shop.example/cb?order=1'), InvalidArgumentError);
  await assert.rejects(card.createWallet('0x12 34', CALLBACK), InvalidArgumentError);
  assert.equal(http.requests.length, 0);
});

test('callback must not carry PayGate parameter names', async () => {
  await assert.rejects(card.createWallet(WALLET, 'https://shop.example/cb?order=1&value_coin=5000'), /value_coin/);
});

test('an injected address is encoded, not passed through', () => {
  assert.ok(card.paymentUrl('abc%2Fdef&domain=evil.example', '10', 'a@b.co', 'USD').startsWith(
    'https://checkout.paygate.to/pay.php?address=abc%252Fdef%26domain%3Devil.example&amount=10'));
});

test('missing address_in is an API error', async () => {
  http.respond({ status: 'success' });
  await assert.rejects(card.createWallet(WALLET, CALLBACK), ApiError);
});

test('affiliate endpoints', async () => {
  http.respond(walletResponse).respond(walletResponse).respond(walletResponse);
  await card.createAffiliateWallet(WALLET, CALLBACK, '0xAffiliate');
  assert.equal(http.lastPath, '/control/affiliate.php');
  assert.ok(http.lastQuery.endsWith('&affiliate=0xAffiliate'));

  await card.createAffiliateWallet(WALLET, CALLBACK, '0xAffiliate', { affiliateFee: 0.04, merchantFee: '0.95' });
  assert.equal(http.lastPath, '/control/custom-affiliate.php');
  assert.ok(http.lastQuery.endsWith('&affiliate=0xAffiliate&affiliate_fee=0.04&merchant_fee=0.95'));

  await card.createSubAffiliateWallet(WALLET, CALLBACK, '0xAff', '0xSub', { affiliateFee: 0.02, subAffiliateFee: 0.01, merchantFee: 0.96 });
  assert.equal(http.lastPath, '/control/custom-sub-affiliate.php');
  const q = new URLSearchParams(http.lastQuery);
  assert.deepEqual([q.get('affiliate_fee'), q.get('merchant_fee'), q.get('sub_affiliate_fee'), q.get('sub_affiliate')], ['0.02', '0.96', '0.01', '0xSub']);
});

test('fee shares must total 0.99 and be below 1', async () => {
  await assert.rejects(card.createAffiliateWallet(WALLET, CALLBACK, '0xA', { affiliateFee: 0.05, merchantFee: 0.95 }), /0\.99/);
  await assert.rejects(card.createAffiliateWallet(WALLET, CALLBACK, '0xA', { affiliateFee: 5, merchantFee: 94 }), /0\.01 for 1%/);
});

test('mass payout posts JSON', async () => {
  http.respond(walletResponse);
  await card.createMassPayoutWallet(CALLBACK, { '0xA': 0.5, '0xB': '0.49' });
  assert.equal(http.last.method, 'POST');
  assert.equal(http.last.url, 'https://api.paygate.to/control/mass-payout.php');
  assert.equal(http.last.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(http.last.body), { callback: CALLBACK, fees: { '0xA': 0.5, '0xB': 0.49 } });
});

test('mass payout is limited to 19 wallets', async () => {
  const shares = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['0x' + i, 0.0495]));
  await assert.rejects(card.createMassPayoutWallet(CALLBACK, shares), InvalidArgumentError);
});

test('paymentUrl keeps address_in encoded once', () => {
  assert.equal(
    card.paymentUrl(ADDRESS_IN, 49.9, 'buyer+1@example.com', 'eur'),
    `https://checkout.paygate.to/pay.php?address=${ADDRESS_IN}&amount=49.9&email=buyer%2B1%40example.com&currency=EUR`,
  );
  assert.match(card.paymentUrl({ addressIn: 'abc+/=' }, '10', 'a@b.co', 'USD'), /address=abc%2B%2F%3D&/);
});

test('paymentUrl with a provider', () => {
  assert.equal(
    card.paymentUrl(ADDRESS_IN, '100', 'a@b.co', 'USD', { provider: 'wert' }),
    `https://checkout.paygate.to/process-payment.php?address=${ADDRESS_IN}&amount=100&provider=wert&email=a%40b.co&currency=USD`,
  );
  assert.throws(() => card.paymentUrl(ADDRESS_IN, '100', 'a@b.co', 'USD', { provider: 'wert', branding: { theme: 'red' } }), InvalidArgumentError);
});

test('paymentUrl branding', () => {
  const url = new URL(card.paymentUrl(ADDRESS_IN, '100', 'a@b.co', 'USD', {
    branding: { domain: 'https://pay.myshop.com/', logo: 'https://myshop.com/logo.png', background: '#ffffff', theme: 'red', button: '#000' },
  }));
  assert.equal(url.searchParams.get('domain'), 'pay.myshop.com');
  assert.equal(url.searchParams.get('logo'), 'https://myshop.com/logo.png');
  assert.equal(url.searchParams.get('background'), '#ffffff');
  assert.throws(() => card.paymentUrl(ADDRESS_IN, '100', 'a@b.co', 'USD', { branding: { colour: 'red' } }), /Unknown branding option/);
});

for (const [name, amount, email, currency] of [
  ['zero amount', 0, 'a@b.co', 'USD'],
  ['negative amount', '-5', 'a@b.co', 'USD'],
  ['text amount', 'ten', 'a@b.co', 'USD'],
  ['NaN', NaN, 'a@b.co', 'USD'],
  ['no email', '10', '', 'USD'],
  ['bad currency', '10', 'a@b.co', 'dollars'],
]) {
  test(`paymentUrl rejects ${name}`, () => {
    assert.throws(() => card.paymentUrl(ADDRESS_IN, amount, email, currency), InvalidArgumentError);
  });
}

test('providers', async () => {
  http.respond({ providers: [
    { id: 'wert', provider_name: 'Wert.io', status: 'active', minimum_currency: 'USD', minimum_amount: 1 },
    { id: 'stripe', provider_name: 'Stripe (USA)', status: 'inactive', minimum_currency: 'USD', minimum_amount: 2 },
  ] });
  const providers = await card.providers();
  assert.equal(providers.length, 2);
  assert.deepEqual(providers[0], { id: 'wert', name: 'Wert.io', status: 'active', active: true, minimumCurrency: 'USD', minimumAmount: '1' });
  assert.equal(providers[1].active, false);
});

test('convertToUsd', async () => {
  http.respond({ status: 'success', value_coin: '54.20', exchange_rate: '0.92' });
  assert.deepEqual(await card.convertToUsd('49.90', 'eur'), { value: '54.20', exchangeRate: '0.92' });
  assert.equal(http.lastQuery, 'from=EUR&value=49.90');
  assert.deepEqual(await card.convertToUsd(10, 'USD'), { value: '10', exchangeRate: '1' });
  assert.equal(http.requests.length, 1);
});

test('paymentStatus', async () => {
  http.respond({ status: 'paid', value_coin: '117.59', txid_out: '0xe85e', coin: 'polygon_usdc' });
  const status = await card.paymentStatus('ZEE2cW8z%3D');
  assert.equal(status.paid, true);
  assert.equal(status.valueCoin, '117.59');
  assert.equal(http.lastQuery, 'ipn_token=ZEE2cW8z%3D');
});
