// A small Express shop taking card, crypto and hosted multi-coin payments with PayGate.to.
//
// Settings come from environment variables, so nothing secret is written in the file:
//   PAYGATE_USDC_WALLET      your USDC (Polygon) wallet for card payouts, 0x...
//   PAYGATE_BTC_WALLET       your Bitcoin wallet
//   PAYGATE_EVM_WALLET       your EVM wallet: ETH, USDT and USDC on ERC20, BEP20, Polygon...
//   PAYGATE_CALLBACK_SECRET  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   PAYGATE_SITE_URL         public URL of this server, e.g. https://shop.example
//   PAYGATE_API_DOMAIN       optional: your dedicated API endpoint
//   PAYGATE_CHECKOUT_DOMAIN  optional: your white-label checkout domain
//   PORT                     default 3000
//
//   npm install && npm start

import { randomBytes } from 'node:crypto';
import express from 'express';
import { CallbackData, CallbackToken, PayGate, PayGateError, coinId } from 'paygate-to';

const env = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set the ${name} environment variable.`);
  }
  return value;
};

const paygate = new PayGate({
  apiDomain: process.env.PAYGATE_API_DOMAIN || undefined,
  checkoutDomain: process.env.PAYGATE_CHECKOUT_DOMAIN || undefined,
});
const tokens = new CallbackToken(env('PAYGATE_CALLBACK_SECRET'));
const SITE_URL = env('PAYGATE_SITE_URL').replace(/\/+$/, '');

// The registered callback URL. Keep it a constant: signatures are checked against it.
const CALLBACK_URL = `${SITE_URL}/paygate/callback`;

// Orders live in memory here. Use your database in production.
const orders = new Map();
const newOrder = (fields) => {
  const id = randomBytes(6).toString('hex');
  orders.set(id, { status: 'pending', txids: [], received: {}, payments: [], ...fields });
  return id;
};

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A query parameter as a string (repeated or array parameters are ignored).
const param = (req, name, fallback) => (typeof req.query[name] === 'string' && req.query[name] !== '' ? req.query[name] : fallback);

// Your payout wallet for a coin: Bitcoin for btc, the EVM wallet for ETH and EVM tokens.
const EVM_CHAINS = ['eth', 'erc20', 'bep20', 'polygon', 'arbitrum', 'base', 'optimism', 'avax-c', 'linea', 'monad'];
const payoutWalletFor = (coin) => {
  const id = coinId(coin);
  if (id === 'btc') return process.env.PAYGATE_BTC_WALLET;
  if (EVM_CHAINS.includes(id.split('_')[0])) return process.env.PAYGATE_EVM_WALLET;
  return undefined; // add your wallets for other networks (ltc, sol, trc20...) here
};

// Records a confirmed payment. Payments in the same unit add up, a paid order stays paid, and the
// order is paid once the total reaches tolerance × expected.
const recordPayment = (order, txid, unit, value, expected, tolerance) => {
  order.received[unit] = (order.received[unit] ?? 0) + Number(value);
  if (order.status !== 'paid') {
    order.status = order.received[unit] >= Number(expected) * tolerance ? 'paid' : 'underpaid';
  }
};

const app = express();

// Card: Visa, Mastercard, Apple Pay, Google Pay... paid out in USDC on Polygon.
app.get('/checkout/card', async (req, res, next) => {
  try {
    // In a real shop these come from the order, never from the query string.
    const amount = param(req, 'amount', '49.90');
    const currency = param(req, 'currency', 'USD');
    const email = param(req, 'email', 'buyer@example.com');

    // What you expect in USDC: the payment link is visible to the customer, so the callback
    // compares what actually arrived with this.
    const { value: expectedUsd } = await paygate.card.convertToUsd(amount, currency);
    const orderId = newOrder({ method: 'card', amount, currency, expectedUsd });

    const wallet = await paygate.card.createWallet(env('PAYGATE_USDC_WALLET'), tokens.callbackUrl(CALLBACK_URL, { order: orderId }));
    orders.get(orderId).ipnToken = wallet.ipnToken;

    // Hosted page listing the providers that work for the customer. Add { provider: 'wert' } to skip the list.
    res.redirect(303, paygate.card.paymentUrl(wallet, amount, email, currency));
  } catch (error) {
    next(error);
  }
});

// Crypto on your own page: address, amount and QR code.
app.get('/checkout/crypto', async (req, res, next) => {
  try {
    const coin = coinId(param(req, 'coin', 'btc'));
    const amount = param(req, 'amount', '25');
    const currency = param(req, 'currency', 'USD').toUpperCase();
    const payout = payoutWalletFor(coin);
    if (!payout) {
      return res.status(400).type('text').send(`No payout wallet is configured for ${coin}.`);
    }

    const quote = await paygate.crypto.convert(coin, amount, currency);
    const orderId = newOrder({ method: 'crypto', coin, amount, currency, expectedCoin: quote.value });
    const wallet = await paygate.crypto.createWallet(coin, payout, tokens.callbackUrl(CALLBACK_URL, { order: orderId }));
    const qr = await paygate.crypto.qrCode(coin, wallet.addressIn, quote.value);
    orders.get(orderId).addressIn = wallet.addressIn;

    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay order ${escape(orderId)}</title>
<main style="font-family:system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem">
  <h1>Order ${escape(orderId)}</h1>
  <p>Send exactly <strong>${escape(quote.value)} ${escape(coin.toUpperCase())}</strong> (${escape(amount)} ${escape(currency)}) to:</p>
  <p><code style="word-break:break-all">${escape(wallet.addressIn)}</code></p>
  <img src="${escape(qr.dataUri)}" width="240" height="240" alt="QR code of the payment address">
  <p><small>Your order updates automatically once the payment is confirmed.</small></p>
</main>`);
  } catch (error) {
    next(error);
  }
});

// Hosted multi-coin page: the customer picks the coin.
app.get('/checkout/hosted', async (req, res, next) => {
  try {
    const amount = param(req, 'amount', '25');
    const currency = param(req, 'currency', 'USD').toUpperCase();
    const orderId = newOrder({ method: 'hosted', amount, currency });
    const hosted = await paygate.crypto.createHostedWallet(
      { btc: process.env.PAYGATE_BTC_WALLET, evm: process.env.PAYGATE_EVM_WALLET },
      amount,
      currency,
      tokens.callbackUrl(CALLBACK_URL, { order: orderId }),
    );
    // addFees: the customer also pays the network fee. Colours are hex codes or CSS names.
    res.redirect(303, paygate.crypto.hostedPaymentUrl(hosted, { addFees: true, branding: { theme: '#7c3aed' } }));
  } catch (error) {
    next(error);
  }
});

// Callback: PayGate.to calls it when a payment is made.
app.get('/paygate/callback', async (req, res) => {
  // 1. Signature over the registered callback URL + the raw query string (req.originalUrl).
  const result = await paygate.callbacks.verifyRequest(CALLBACK_URL, req);
  if (!result.valid) {
    console.warn('PayGate callback rejected:', result.reason);
    return res.status(403).type('text').send('invalid signature');
  }

  // 2. The order id must carry the token this server issued, so a payment cannot be credited to another order.
  const data = CallbackData.fromRequest(req);
  const orderId = data.get('order');
  if (!tokens.verify(orderId, data.get(tokens.param))) {
    return res.status(403).type('text').send('invalid order token');
  }
  const order = orders.get(orderId);
  if (!order) {
    return res.status(404).type('text').send('unknown order');
  }

  // Wallets created with { pending: true } first send an unconfirmed notice.
  if (data.pending) {
    if (order.status === 'pending') order.status = 'confirming';
    return res.type('text').send('ok');
  }

  // 3. Callbacks can repeat: credit each payment once.
  const txid = data.txidIn;
  if (order.txids.includes(txid)) {
    return res.type('text').send('ok');
  }

  // Reserve the transaction id before any await, so a repeated callback arriving meanwhile is ignored.
  order.txids.push(txid);

  // 4. Coin and amount.
  const coin = coinId(data.coin ?? '');
  let payouts = {};
  try {
    payouts = data.payouts();
  } catch {
    // informational only: never let it block the payment
  }
  order.payments.push({ txid, coin, value: data.valueCoin, payouts });
  const isStablecoin = /_(usdc|usdt)$/.test(coin);
  if (order.method === 'card' && !isStablecoin) {
    // Card payments arrive in USDC or USDT; anything else was sent to the address directly.
    if (order.status !== 'paid') order.status = 'wrong_coin';
  } else if (order.method === 'card') {
    // USDC (or USDT) after the provider's fee. 0.60 tolerates high provider fees while catching a
    // customer who edited the amount in the payment link (the official plugins use the same default).
    recordPayment(order, txid, 'usd', data.valueCoin, order.expectedUsd, 0.6);
  } else if (order.method === 'crypto' && coin !== order.coin) {
    // A different token was sent to the address: forwarded to you, but not what was asked for.
    if (order.status !== 'paid') order.status = 'wrong_coin';
  } else if (order.method === 'crypto') {
    recordPayment(order, txid, coin, data.valueCoin, order.expectedCoin, 0.98);
  } else {
    // Hosted page: the customer chose the coin, so price the order in that coin now.
    try {
      const { value } = await paygate.crypto.convert(coin, order.amount, order.currency);
      recordPayment(order, txid, coin, data.valueCoin, value, 0.95);
    } catch {
      order.payments.pop();
      order.txids.splice(order.txids.indexOf(txid), 1);
      return res.status(503).type('text').send('price unavailable'); // not "ok": PayGate.to will call again
    }
  }
  res.type('text').send('ok');
});

// Order status, for this demo only.
app.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.sendStatus(404);
  const { ipnToken, ...visible } = order;
  return res.json(visible);
});

app.use((error, req, res, next) => {
  if (error instanceof PayGateError) {
    console.error(error.message);
    return res.status(502).type('text').send('Payment could not be started: ' + error.message);
  }
  next(error);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Shop on http://localhost:${port} (callbacks to ${CALLBACK_URL})`));
