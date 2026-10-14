// Read-only calls against the live API. Opt in: PAYGATE_INTEGRATION=1 npm run test:integration
// PAYGATE_API_DOMAIN selects your dedicated endpoint. Set PAYGATE_TEST_EVM_WALLET (a wallet you own)
// to also create a card and a crypto wallet; nothing is charged.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PayGate } from '../../dist/esm/index.js';

const enabled = process.env.PAYGATE_INTEGRATION === '1';
const paygate = enabled ? new PayGate(process.env.PAYGATE_API_DOMAIN ? { apiDomain: process.env.PAYGATE_API_DOMAIN } : {}) : null;

describe('live API', { skip: !enabled && 'set PAYGATE_INTEGRATION=1 to call the live API' }, () => {
  test('coin list', async () => {
    const coins = await paygate.crypto.coins();
    assert.ok(coins.btc);
    assert.match(coins.btc.minimum, /^\d+(\.\d+)?$/);
  });

  test('info, convert and fees', async () => {
    const info = await paygate.crypto.info('btc');
    assert.equal(info.coin, 'Bitcoin');
    assert.ok(info.prices.USD);
    assert.ok(Number((await paygate.crypto.convert('btc', '100', 'USD')).value) > 0);
    assert.notEqual((await paygate.crypto.fees('btc')).coin, '');
  });

  test('card conversion and providers', async () => {
    assert.ok(Number((await paygate.card.convertToUsd('100', 'EUR')).value) > 0);
    assert.ok(Array.isArray(await paygate.card.providers()));
  });

  test('wallet creation', { skip: !process.env.PAYGATE_TEST_EVM_WALLET && 'set PAYGATE_TEST_EVM_WALLET' }, async () => {
    const wallet = process.env.PAYGATE_TEST_EVM_WALLET;
    const callback = `https://example.com/paygate-sdk-test?order=${Date.now()}`;
    const card = await paygate.card.createWallet(wallet, callback);
    assert.ok(card.addressIn);
    assert.match(paygate.card.paymentUrl(card, '10', 'test@example.com', 'USD'), /^https:\/\//);
    assert.ok((await paygate.crypto.createWallet('polygon_usdc', wallet, callback)).addressIn);
  });
});
