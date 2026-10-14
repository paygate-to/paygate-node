# PayGate.to Node.js SDK

Accept card and crypto payments in Node.js without KYC, with every payment forwarded instantly to your own wallet.

- **Cards**: Visa, Mastercard, Apple Pay, Google Pay and more through the hosted checkout. You receive USDC on Polygon.
- **Crypto**: Bitcoin, Ethereum, USDT, USDC, Solana, Litecoin and many more on your own page with a QR code, or on the hosted multi-coin page, which also takes Monero, Zcash and TON.
- **Callbacks**: PayGate.to's RSA signature is checked against the bundled public key. Payout amounts are decoded exactly.
- **White label**: you can use your own checkout domain, logo and colours, earn affiliate commissions, and split payouts across up to 19 wallets.

Node.js 18 or newer. TypeScript types included, ESM and CommonJS, no dependencies.

Full guide: <https://paygate.to/docs/sdk/node/>

## Contents

- [Install](#install)
- [Card payments](#card-payments)
- [Crypto payments on your page](#crypto-payments-on-your-page)
- [Hosted multi-coin page](#hosted-multi-coin-page)
- [Handling the callback](#handling-the-callback)
- [White label, affiliates and split payouts](#white-label-affiliates-and-split-payouts)
- [Coin data, conversion and status](#coin-data-conversion-and-status)
- [Configuration](#configuration)
- [Errors](#errors)
- [Examples](#examples)
- [Testing](#testing)
- [Security notes](#security-notes)
- [API reference](#api-reference)

## Install

```bash
npm install paygate-to
```

```js
import { PayGate } from 'paygate-to';            // or: const { PayGate } = require('paygate-to');

const paygate = new PayGate();
```

## Card payments

There are three steps for each order:
1. Create a wallet tied to the order's callback URL.
2. Send the customer to the payment link.
3. Credit the order when the signed callback arrives.

```js
import { CallbackToken } from 'paygate-to';

const tokens = new CallbackToken(process.env.PAYGATE_CALLBACK_SECRET);   // 64 random hex chars, kept on your server

// Your callback URL. It carries the order id and a token so the id cannot be swapped.
const callback = tokens.callbackUrl('https://shop.example/paygate/callback', { order: order.id });

const wallet = await paygate.card.createWallet('0xYourPolygonUsdcWallet', callback);

// What you expect to receive, in USD: the callback compares the amount that arrived with this.
order.expectedUsd = (await paygate.card.convertToUsd(order.total, 'EUR')).value;

res.redirect(paygate.card.paymentUrl(wallet, order.total, order.email, 'EUR'));
```

The customer can see the amount in the payment link, so always compare what arrives with what you expect (see [Handling the callback](#handling-the-callback)).

`paymentUrl()` opens the hosted page, which lists the providers available for the customer's country, amount and currency. You can send the customer straight to one provider instead. `providers()` lists the providers, with their status and minimum order:

```js
for (const provider of await paygate.card.providers()) {
  if (provider.active) console.log(provider.id, provider.name, provider.minimumAmount, provider.minimumCurrency);
}

paygate.card.paymentUrl(wallet, '49.90', 'buyer@example.com', 'USD', { provider: 'wert' });
```

The same callback URL always returns the same wallet, so rebuilding the link for an order is safe. Store `wallet.ipnToken` if you want to use `paymentStatus()` later.

## Crypto payments on your page

```js
const wallet = await paygate.crypto.createWallet('btc', 'bc1qYourBitcoinWallet', callback);
const quote = await paygate.crypto.convert('btc', order.total, 'USD');     // { value: '0.00041512', exchangeRate: … }
const qr = await paygate.crypto.qrCode('btc', wallet.addressIn, quote.value);

// Show these on your checkout page (escape them like any other value you put in HTML)
res.render('pay', { address: wallet.addressIn, amount: quote.value, qr: qr.dataUri });
```

Coins are written as `btc`, `erc20_usdc` or `erc20/usdc`; all three forms work. Use a payout wallet on the coin's network, for example an EVM address for ERC20, BEP20 and Polygon tokens.

Wallet options:

```js
await paygate.crypto.createWallet('ltc', myLtcWallet, callback, {
  pending: true,       // also send a callback (pending=1) when the transaction is first seen
  confirmations: 3,    // confirmations required before the confirmed callback
});
```

## Hosted multi-coin page

The customer picks a coin on the hosted page. Pass one wallet for each network you accept (`HOSTED_NETWORKS`: `evm`, `btc`, `bitcoincash`, `ltc`, `doge`, `solana`, `trc20`, `xmr`, `zec`, `ton`).

```js
const hosted = await paygate.crypto.createHostedWallet({
  btc: 'bc1qYourBitcoinWallet',
  evm: '0xYourEvmWallet',            // ETH, USDT, USDC… on ERC20, BEP20, Polygon, Arbitrum, Base…
  solana: 'YourSolanaWallet',
}, order.total, 'USD', callback);

res.redirect(paygate.crypto.hostedPaymentUrl(hosted, {
  addFees: true,                     // the customer pays the network fee
  branding: { theme: '#7c3aed' },    // hex codes or CSS colour names
}));
```

## Handling the callback

When a payment arrives, PayGate.to requests your callback URL with your parameters plus the payment data. The request is signed. Check the signature first, and reject the request if the check fails:

```js
import { CallbackData, coinId } from 'paygate-to';

const CALLBACK_URL = 'https://shop.example/paygate/callback';   // as registered

app.get('/paygate/callback', async (req, res) => {
  const result = await paygate.callbacks.verifyRequest(CALLBACK_URL, req);
  if (!result.valid) return res.sendStatus(403);                // result.reason says why, e.g. signature_mismatch

  const data = CallbackData.fromRequest(req);
  if (!tokens.verify(data.get('order'), data.get('token'))) return res.sendStatus(403);

  if (data.pending) return res.send('ok');                      // seen, not yet confirmed: do not ship

  const order = await findOrder(data.get('order'));
  if (order.hasTransaction(data.txidIn)) return res.send('ok'); // callbacks can repeat: credit each payment once

  await order.addPayment(data.txidIn, data.coin, data.valueCoin);

  // Release the goods only when the right coin and enough of it arrived. Card payments arrive in
  // USDC after the provider's fee: the official plugins accept 60% of the USD total or more.
  const paid = order.method === 'card'
    ? order.receivedTotal() >= 0.6 * Number(order.expectedUsd)
    : coinId(data.coin) === coinId(order.coin) && order.receivedTotal() >= 0.98 * Number(order.expectedCoin);
  await order.setStatus(paid ? 'paid' : 'underpaid');
  res.send('ok');
});
```

Each check matters:

- **Signature**: proves PayGate.to sent the request and that nothing in it was changed.
- **Token**: the callback URL is chosen when the wallet is created, so anyone can create a wallet whose callback names one of your orders and pay it a few cents. The token proves your server issued that order reference. Without tokens, compare `data.addressIn` with the order's deposit address (`wallet.polygonAddressIn` for cards, `wallet.addressIn` for crypto); the hosted page has no address in advance, so use tokens there.
- **Transaction id**: callbacks are repeated until you answer `ok`.
- **Coin and amount**: the payment link is visible to the customer, and any token can be sent to a crypto address.
- **Payout address**: callback URLs end up in web server logs. With a leaked URL, someone could create a wallet that pays *them* and still call your callback. `data.payoutFor('0xYourWallet')` returns what reached your wallet (undefined if nothing did). Expect it to be at least 90% of the amount forwarded.

Pass `verifyRequest()` the callback URL you registered, as a constant in your code. Only its scheme, host and path are used. The signed string is that URL followed by the query string exactly as it arrived. The SDK reads it from `req.originalUrl` (Express) or `req.url` (Node's `http`) and never rebuilds it, because one changed byte invalidates the signature. Don't rebuild the query from `req.query` or `URLSearchParams`. With another framework, call `verify()` with the raw query string:

```js
const result = await paygate.callbacks.verify(CALLBACK_URL, rawQueryString, signatureHeader, keyIdHeader);
```

Never use PayGate.to's parameter names (`PAYGATE_PARAMS`: `value_coin`, `coin`, `txid_in`, `txid_out`, `address_in`, `value_forwarded_coin`, `address_out`, `pending`) in your callback URL; the SDK refuses them. If a name appears twice, `CallbackData` uses the last value, which is PayGate.to's.

### Payment data

| Property | Value |
|---|---|
| `valueCoin` | Amount received. Card payments arrive in USDC (or USDT) on Polygon, after the provider's fee. Crypto payments are in the coin that was paid. |
| `coin` | `polygon_usdc`, `btc`, `erc20_usdt`… |
| `txidIn` | Transaction that paid the order's address. Use it to credit each payment once. |
| `txidOut` | Transaction that forwarded the funds to you. |
| `addressIn` | The order's deposit address. |
| `valueForwardedCoin` | Total forwarded to you and to any affiliates. |
| `addressOut` | Share received by each payout address, e.g. `{ '0xYou': '0.925' }`. |
| `payouts(scale?)` | Exact amount sent to each address (share × forwarded), computed without floating point. Pass a scale to round half up. |
| `pending` | True for an unconfirmed crypto notice. |
| `get('order')` | Any of your own parameters. |

### Key rotation

The published key is bundled under the id `v1`. If PayGate.to introduces a new key, you can supply it without upgrading the SDK:

```js
import { readFile } from 'node:fs/promises';

const paygate = new PayGate({
  callbacks: {
    keyResolver: (keyId) => readFile(`./keys/paygate_callback_public_${keyId}.pem`, 'utf8').catch(() => null),
  },
});
```

Concurrent lookups for one key id share a call. An id the resolver doesn't know is asked again after 10 minutes, so a forged key id can't block a real key published later.

## White label, affiliates and split payouts

```js
// Use your own checkout domain and branding (hosted pages)
const paygate = new PayGate({
  apiDomain: 'api-yourshop-1a2b3c.paygate.to',   // your free dedicated endpoint
  checkoutDomain: 'pay.yourshop.com',
});
paygate.card.paymentUrl(wallet, '25', email, 'USD', {
  branding: { logo: 'https://yourshop.com/logo.png', background: '#ffffff', theme: '#7c3aed', button: '#111827' },
});

// Earn a commission on a merchant's sales: shares must add up to 0.99 (PayGate.to keeps 1%)
await paygate.card.createAffiliateWallet(merchantWallet, callback, yourWallet, { affiliateFee: 0.02, merchantFee: 0.97 });
await paygate.crypto.createAffiliateWallet('trc20_usdt', merchantWallet, callback, yourWallet, { affiliateFee: 0.02, merchantFee: 0.97 });

// Split each payment across up to 19 wallets
await paygate.card.createMassPayoutWallet(callback, { '0xPartnerA': 0.5, '0xPartnerB': 0.49 });
```

Without fees, `createAffiliateWallet()` gives the affiliate the default commission. `createSubAffiliateWallet()` adds a third wallet.

## Coin data, conversion and status

```js
await paygate.crypto.coins();                     // { btc: Coin, erc20_usdc: Coin, … } with name, logo, minimum
await paygate.crypto.info('erc20_usdc');          // { coin: 'USD Coin', minimum: '…', prices: { USD: '1.00', … } }
await paygate.crypto.price('btc', 'EUR');         // '51756.00'
await paygate.crypto.fees('btc');                 // estimated network fee, in BTC and in fiat
await paygate.crypto.convert('sol_sol', '20', 'GBP');

await paygate.card.convertToUsd('49.90', 'EUR');

// Occasional checks only. These endpoints are rate limited, so update orders from the callback.
await paygate.card.paymentStatus(ipnToken);                 // { status: 'paid', paid: true, … }
await paygate.crypto.paymentStatus(ipnToken, 'bep20_usdt');
```

Amounts are returned as plain decimal strings (`'0.00001'`, never `1e-5`), so they keep their full precision.

## Configuration

```js
new PayGate({
  apiDomain: 'api.paygate.to',            // or your dedicated endpoint
  checkoutDomain: 'checkout.paygate.to',  // or your white-label domain
  timeoutMs: 30000,
  retries: 1,                             // extra attempts for GET on network errors; POST and createSwap() are never retried
  userAgent: 'my-shop/2.0',
  fetch: myFetch,                         // any WHATWG fetch; defaults to the global fetch
  callbacks: { keys, keyResolver },       // see Key rotation; default: the bundled "v1" key
});
```

Unknown options throw an error, so a misspelled option fails loudly instead of being ignored. Redirects are never followed.

## Errors

Every SDK error extends `PayGateError`:

| Error | When |
|---|---|
| `InvalidArgumentError` | Your input was rejected before any request. Examples: a callback without an order parameter, fee shares that don't add up to 0.99, or a bad currency code. |
| `ApiError` | PayGate.to answered with an error, a non-2xx status or a body that isn't JSON. See `statusCode` and `responseBody`. |
| `TransportError` | The request never completed (DNS, TLS, timeout). |

```js
import { PayGateError } from 'paygate-to';

try {
  await paygate.card.createWallet(payoutWallet, callback);
} catch (error) {
  if (error instanceof PayGateError) console.error(error.message);   // query strings are never included
  else throw error;
}
```

## Examples

| File | What it does |
|---|---|
| `examples/express/server.mjs` | A small Express shop: card, on-site crypto and hosted checkouts, and a callback handler that checks the signature, token, repeats, pending notices, coin and amount. |
| `examples/http-callback.mjs` | A callback endpoint with only Node's `http` module. |
| `examples/list-coins.mjs` | Prints every coin with its minimum. |

```bash
cd examples/express && npm install
export PAYGATE_USDC_WALLET=0x… PAYGATE_BTC_WALLET=bc1q… PAYGATE_EVM_WALLET=0x…
export PAYGATE_CALLBACK_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export PAYGATE_SITE_URL=https://your-public-url
npm start
```

Callbacks need a public URL, so the example must be served from a public address. Running it only on localhost is not enough.

## Testing

```bash
npm test                                           # build, then unit tests (no network)
PAYGATE_INTEGRATION=1 npm run test:integration     # read-only calls to the live API
```

In your own tests, pass a fake `fetch` to `PayGate`. `test/helpers.mjs` shows how. To test your callback handler, create a `CallbackVerifier` with your own test key pair (`new CallbackVerifier({ keys: { v1: testPublicPem } })`) and sign the URL with `crypto.sign('sha256', …)`.

## Security notes

- Always verify the signature, and answer 403 when it fails. A callback that has not been verified proves nothing; the `User-Agent` header can be set by anyone.
- Keep `PAYGATE_CALLBACK_SECRET` on your server only. It stops a valid payment for one order from being replayed against another.
- Credit each `txidIn` once. Callbacks are retried and can arrive more than once.
- Compare the coin and the amount received with the order before releasing goods. Customers can see and edit the card payment link.
- Never use PayGate.to's parameter names in your callback URL.
- Use a self-custodial wallet you control for payouts.

## API reference

**`PayGate`**: `card`, `crypto`, `callbacks`, `apiDomain`, `checkoutDomain`

**`paygate.card`** (`CardApi`)
- Wallets: `createWallet(payoutWallet, callbackUrl)`, `createAffiliateWallet(payoutWallet, callbackUrl, affiliateWallet, fees?)`, `createSubAffiliateWallet(…)`, `createMassPayoutWallet(callbackUrl, shares)`
- Payment link: `paymentUrl(wallet, amount, email, currency, { provider?, branding? })`
- Data: `providers()`, `convertToUsd(amount, from)`, `paymentStatus(ipnToken)`

**`paygate.crypto`** (`CryptoApi`)
- Coin data: `coins(affiliate?)`, `info(coin, affiliate?)`, `price(coin, fiat)`, `fees(coin, affiliate?)`, `convert(coin, amount, fiat)`
- Wallets: `createWallet(coin, payoutWallet, callbackUrl, options?)`, `createAffiliateWallet(…)`, `createMassPayoutWallet(…)`, `massPayoutFees(coin, count)`
- Display: `qrCode(coin, address, amount?)`
- Hosted page: `createHostedWallet(wallets, fiatAmount, fiatCurrency, callbackUrl)`, `hostedPaymentUrl(wallet, { addFees?, branding? })`
- Status and swaps: `paymentStatus(ipnToken, coin)`, `swapCoins()`, `createSwap(from, to, toWallet, amount, callbackUrl, affiliate?)`, `swapStatus(exchangeId)`

**Callbacks**
- `CallbackVerifier`: `verify()`, `verifyRequest()`, `addKey()`
- `CallbackData`: see the payment data table above
- `CallbackToken`: `callbackUrl()`, `sign()`, `verify()`. Its tokens match the PHP SDK's for the same secret.
- Helpers: `coinId()`, `coinPath()`, `rawQueryFrom()`, `callbackBase()`, `PAYGATE_PARAMS`, `HOSTED_NETWORKS`

The API is documented at <https://paygate.to/docs/payment-gateway-api/> (cards) and <https://paygate.to/docs/crypto-payment-api/> (crypto).

## License

MIT. See [LICENSE](LICENSE).
