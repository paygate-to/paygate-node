import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ApiError, InvalidArgumentError, PayGate, coinId, coinPath } from '../../dist/esm/index.js';
import { FakeFetch } from '../helpers.mjs';

const CALLBACK = 'https://shop.example/cb?order=77';
let http;
let crypto;
beforeEach(() => {
  http = new FakeFetch();
  crypto = new PayGate({ fetch: http.fetch }).crypto;
});

test('coin identifiers', () => {
  assert.equal(coinId('erc20/usdc'), 'erc20_usdc');
  assert.equal(coinPath('erc20_usdc'), 'erc20/usdc');
  assert.equal(coinPath('ERC20/USDC'), 'erc20/usdc');
  assert.equal(coinPath('btc'), 'btc');
  assert.equal(coinPath('arbitrum_usdc.e'), 'arbitrum/usdc.e');
});

test('coins() flattens chain groups', async () => {
  http.respond('{"btc":{"coin":"Bitcoin","logo":"https://x/btc.png","ticker":"btc","minimum_transaction_coin":1e-05},'
    + '"erc20":{"usdc":{"coin":"USD Coin","logo":"https://x/usdc.png","ticker":"usdc","minimum_transaction_coin":"10"},'
    + '"usdt":{"coin":"Tether","logo":"https://x/usdt.png","ticker":"usdt","minimum_transaction_coin":10}}}');
  const coins = await crypto.coins();
  assert.deepEqual(Object.keys(coins), ['btc', 'erc20_usdc', 'erc20_usdt']);
  assert.equal(coins.btc.minimum, '0.00001');
  assert.equal(coins.erc20_usdc.path, 'erc20/usdc');
  assert.equal(coins.erc20_usdc.chain, 'erc20');
  assert.equal(coins.erc20_usdc.label, 'USD Coin (ERC20)');
  assert.equal(http.lastPath, '/crypto/info.php');
  http.respond({});
  await crypto.coins(true);
  assert.equal(http.lastPath, '/crypto/aff-info.php');
});

test('info keeps numbers as plain strings', async () => {
  http.respond('{"coin":"Bitcoin","minimum":0.00010640000000000001,"prices":{"USD":"60000.00","eur":51756.5}}');
  const info = await crypto.info('btc');
  assert.equal(info.coin, 'Bitcoin');
  assert.match(info.minimum, /^0\.0001064\d*$/);
  assert.deepEqual(info.prices, { USD: '60000.00', EUR: '51756.5' });
});

test('price', async () => {
  http.respond({ coin: 'Bitcoin', minimum: '0.0001', prices: { USD: '60000.00' } });
  assert.equal(await crypto.price('btc', 'usd'), '60000.00');
  http.respond({ coin: 'Bitcoin', minimum: '0.0001', prices: { USD: '60000.00' } });
  await assert.rejects(crypto.price('btc', 'JPY'), ApiError);
});

test('fees and convert', async () => {
  http.respond({ status: 'success', estimated_cost: 2.5e-6, estimated_cost_currency: { USD: '0.15' } });
  assert.deepEqual(await crypto.fees('btc'), { coin: '0.0000025', fiat: { USD: '0.15' } });
  assert.equal(http.lastPath, '/crypto/btc/fees.php');

  http.respond({ status: 'success', value_coin: '0.00083', exchange_rate: '0.0000166' });
  assert.deepEqual(await crypto.convert('btc', '49.80', 'USD'), { value: '0.00083', exchangeRate: '0.0000166' });
  assert.equal(http.lastQuery, 'from=usd&value=49.80');
});

test('createWallet with options', async () => {
  http.respond({ address_in: '0xIn', callback_url: CALLBACK, ipn_token: 'aXBu' });
  const wallet = await crypto.createWallet('erc20/usdc', '0xMine', CALLBACK, { pending: true, confirmations: 3 });
  assert.equal(http.lastPath, '/crypto/erc20/usdc/wallet.php');
  assert.equal(http.lastQuery, `address=0xMine&callback=${encodeURIComponent(CALLBACK)}&pending=1&confirmations=3`);
  assert.deepEqual([wallet.coin, wallet.addressIn, wallet.ipnToken], ['erc20_usdc', '0xIn', 'aXBu']);
});

test('wallet option and coin validation', async () => {
  await assert.rejects(crypto.createWallet('btc', 'bc1q', CALLBACK, { confirm: 2 }), /Unknown wallet option/);
  await assert.rejects(crypto.createWallet('btc', 'bc1q', CALLBACK, { confirmations: 0 }), InvalidArgumentError);
  for (const bad of ['../control', 'erc20/..', 'btc?x=1', 'a/b/c', ' ']) {
    await assert.rejects(crypto.createWallet(bad, 'bc1q', CALLBACK), InvalidArgumentError, bad);
  }
  assert.equal(http.requests.length, 0);
});

test('affiliate wallets', async () => {
  http.respond({ address_in: 'a' }).respond({ address_in: 'b' });
  await crypto.createAffiliateWallet('trc20_usdt', 'TMine', CALLBACK, 'TAff');
  assert.equal(http.lastPath, '/crypto/trc20/usdt/affiliate.php');
  await crypto.createAffiliateWallet('trc20_usdt', 'TMine', CALLBACK, 'TAff', { affiliateFee: '0.01', merchantFee: '0.98' });
  assert.equal(http.lastPath, '/crypto/trc20/usdt/custom-affiliate.php');
  assert.ok(http.lastQuery.includes('&affiliate_fee=0.01&merchant_fee=0.98'));
});

test('mass payout', async () => {
  http.respond({ address_in: 'bc1qin' });
  await crypto.createMassPayoutWallet('btc', CALLBACK, { bc1qa: 0.33, bc1qb: 0.33, bc1qc: 0.33 }, { pending: true });
  assert.equal(http.last.method, 'POST');
  assert.equal(http.last.url, 'https://api.paygate.to/crypto/btc/mass-payout.php?pending=1');
  assert.deepEqual(JSON.parse(http.last.body).fees, { bc1qa: 0.33, bc1qb: 0.33, bc1qc: 0.33 });

  http.respond({ estimated_cost: '0.0001', estimated_cost_currency: { USD: 6 } });
  assert.deepEqual(await crypto.massPayoutFees('btc', 3), { feeCoin: '0.0001', feeFiat: { USD: '6' } });
  assert.equal(http.lastQuery, 'wallet_count=3');
  await assert.rejects(crypto.massPayoutFees('btc', 20), InvalidArgumentError);
});

test('qrCode', async () => {
  http.respond({ qr_code: 'iVBORw0KGgo=', payment_uri: 'bitcoin:bc1qin?amount=0.001' });
  const qr = await crypto.qrCode('btc', 'bc1qin', '0.001');
  assert.equal(qr.dataUri, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(qr.paymentUri, 'bitcoin:bc1qin?amount=0.001');
  assert.equal(http.lastQuery, 'address=bc1qin&amount=0.001');
});

test('hosted wallet and page link', async () => {
  http.respond({ payment_token: 'tok%2B%3D', callback_url: CALLBACK, ipn_token: 'aXBu' });
  const hosted = await crypto.createHostedWallet({ BTC: 'bc1qmine', evm: '0xMine', solana: '' }, '25.50', 'eur', CALLBACK);
  assert.equal(http.last.url, 'https://api.paygate.to/crypto/multi-hosted-wallet.php');
  assert.deepEqual(JSON.parse(http.last.body), { btc: 'bc1qmine', evm: '0xMine', fiat_amount: 25.5, fiat_currency: 'EUR', callback: CALLBACK });
  assert.equal(hosted.paymentToken, 'tok%2B%3D');
  assert.equal(
    crypto.hostedPaymentUrl(hosted, { addFees: true, branding: { theme: 'dark', domain: 'pay.myshop.com' } }),
    'https://checkout.paygate.to/crypto/hosted.php?payment_token=tok%2B%3D&add_fees=1&theme=dark&domain=pay.myshop.com',
  );
  assert.equal(crypto.hostedPaymentUrl('tok%2B%3D'), 'https://checkout.paygate.to/crypto/hosted.php?payment_token=tok%2B%3D&add_fees=0');
});

test('hosted wallet validation', async () => {
  await assert.rejects(crypto.createHostedWallet({ eth: '0x1' }, 10, 'USD', CALLBACK), /Unknown network "eth"/);
  await assert.rejects(crypto.createHostedWallet({ btc: ' ' }, 10, 'USD', CALLBACK), /at least one network/);
});

test('paymentStatus encodes the ticker', async () => {
  http.respond({ status: 'unpaid' });
  const status = await crypto.paymentStatus('aXBu%3D', 'bep20_usdt');
  assert.equal(status.paid, false);
  assert.equal(http.lastQuery, 'ipn_token=aXBu%3D&ticker=bep20%2Fusdt');
});

test('a fees answer other than success is an error', async () => {
  http.respond({ status: 'failed' });
  await assert.rejects(crypto.fees('btc'), ApiError);
});

test('swap creation is never retried', async () => {
  http.fail();
  await assert.rejects(crypto.createSwap('btc', 'trc20_usdt', 'TReceive', '0.01', CALLBACK));
  assert.equal(http.requests.length, 1);
});

test('swaps', async () => {
  http.respond({ status: 'success', data: { id: 'x1' } });
  await crypto.createSwap('btc', 'trc20_usdt', 'TReceive', '0.01', CALLBACK, { wallet: 'TAff', fee: 0.05 });
  assert.equal(http.lastPath, '/crypto/btc/aff-swap.php');
  const q = new URLSearchParams(http.lastQuery);
  assert.equal(q.get('ticker_to'), 'trc20/usdt');
  assert.equal(q.get('affiliate_fee'), '0.05');

  http.respond({ tickers: ['btc', 'trc20/usdt'] });
  assert.deepEqual(await crypto.swapCoins(), ['btc', 'trc20/usdt']);

  http.respond({ status: 'success' });
  await crypto.swapStatus('ex 1');
  assert.equal(http.lastQuery, 'exchange_id=ex%201');
});
