import { ApiError, InvalidArgumentError } from './errors.js';
import type { Requester } from './http.js';
import {
  assertShares,
  formatAmount,
  plainNumber,
  queryString,
  stringMap,
  validateBranding,
  validateCallback,
  validateShare,
  validateShares,
  validateWallet,
  type Amount,
  type Branding,
} from './support.js';

/** Networks accepted by createHostedWallet(). "evm" covers ERC20, BEP20, Polygon, Arbitrum, Base, Optimism, Avalanche-C... */
export const HOSTED_NETWORKS = ['evm', 'btc', 'bitcoincash', 'ltc', 'doge', 'solana', 'trc20', 'xmr', 'zec', 'ton'] as const;
export type HostedNetwork = (typeof HOSTED_NETWORKS)[number];

/** A supported coin from coins(). */
export interface Coin {
  /** "btc", "erc20_usdc"... */
  id: string;
  /** "btc", "erc20/usdc": the form used in API paths. */
  path: string;
  ticker: string;
  /** Chain group ("erc20"), empty for native coins. */
  chain: string;
  name: string;
  /** "USD Coin (ERC20)". */
  label: string;
  logo: string;
  /** Minimum amount, plain decimal string. */
  minimum: string;
}

/** The receiving address created for one order. */
export interface CryptoWallet {
  coin: string;
  addressIn: string;
  callbackUrl: string;
  ipnToken: string;
  raw: Record<string, unknown>;
}

/** The hosted multi-coin page prepared for one order. */
export interface HostedWallet {
  /** Already URL-encoded by PayGate.to. */
  paymentToken: string;
  callbackUrl: string;
  ipnToken: string;
  raw: Record<string, unknown>;
}

export interface WalletOptions {
  /** Also send a callback (pending=1) when the transaction is first seen. */
  pending?: boolean;
  /** Confirmations required before the confirmed callback. */
  confirmations?: number;
}

export interface CryptoPaymentStatus {
  status: string;
  paid: boolean;
  valueCoin: string;
  txidIn: string;
  txidOut: string;
  coin: string;
}

/** "erc20/usdc" or "erc20_usdc" -> "erc20_usdc". */
export function coinId(coin: string): string {
  return String(coin ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase().replace(/\//g, '_');
}

/** "erc20_usdc" or "erc20/usdc" -> "erc20/usdc". Only the first underscore separates chain and ticker. */
export function coinPath(coin: string): string {
  const value = String(coin ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (value.includes('/')) {
    return value;
  }
  const pos = value.indexOf('_');
  return pos === -1 ? value : value.slice(0, pos) + '/' + value.slice(pos + 1);
}

function checkedPath(coin: string): string {
  const path = coinPath(coin);
  if (!/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9._-]*)?$/.test(path)) {
    throw new InvalidArgumentError(`"${coin}" is not a coin identifier such as btc or erc20_usdc.`);
  }
  return path;
}

/**
 * Crypto payments: Bitcoin, Solana, Monero, Zcash, ETH, USDT, USDC and many more, forwarded
 * instantly to your own wallets.
 *
 * On your page: createWallet() for the chosen coin, convert() the order total, show the address
 * with qrCode(). Hosted page: createHostedWallet(), then redirect to hostedPaymentUrl().
 */
export class CryptoApi {
  /** @internal Use client.crypto. */
  constructor(private readonly api: Requester, private readonly checkoutHost: string) {}

  /** Every supported coin with its logo and minimum (GET /crypto/info.php, or aff-info.php). Keyed by coin id. */
  async coins(affiliate = false): Promise<Record<string, Coin>> {
    const data = await this.api.get(affiliate ? 'crypto/aff-info.php' : 'crypto/info.php');
    const coins: Record<string, Coin> = {};
    for (const [key, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      if ('ticker' in entry) {
        const coin = coinFrom(String(entry.ticker), '', entry);
        coins[coin.id] = coin;
        continue;
      }
      for (const child of Object.values(entry as Record<string, any>)) {
        if (child && typeof child === 'object' && 'ticker' in child) {
          const coin = coinFrom(String(child.ticker), key, child);
          coins[coin.id] = coin;
        }
      }
    }
    return coins;
  }

  /** Name, minimum and fiat prices of one coin (GET /crypto/{coin}/info.php, or aff-info.php). */
  async info(coin: string, affiliate = false): Promise<{ coin: string; minimum: string; prices: Record<string, string> }> {
    const data = await this.api.get(`crypto/${checkedPath(coin)}/${affiliate ? 'aff-info.php' : 'info.php'}`);
    return {
      coin: String(data.coin ?? ''),
      minimum: plainNumber(data.minimum),
      prices: stringMap(data.prices),
    };
  }

  /** Price of one unit of the coin in a fiat currency. */
  async price(coin: string, fiatCurrency: string): Promise<string> {
    const { prices } = await this.info(coin);
    const currency = String(fiatCurrency ?? '').trim().toUpperCase();
    if (!(currency in prices)) {
      throw new ApiError(`No ${currency} price for ${coinId(coin)}.`);
    }
    return prices[currency];
  }

  /** Estimated blockchain fee to forward a payment, in the network's coin and in fiat (fees.php, aff-fees.php). */
  async fees(coin: string, affiliate = false): Promise<{ coin: string; fiat: Record<string, string> }> {
    const data = success(await this.api.get(`crypto/${checkedPath(coin)}/${affiliate ? 'aff-fees.php' : 'fees.php'}`), 'fees');
    return { coin: plainNumber(data.estimated_cost), fiat: stringMap(data.estimated_cost_currency) };
  }

  /** Convert a fiat amount to the coin, to show the customer what to send (GET /crypto/{coin}/convert.php). */
  async convert(coin: string, amount: Amount, fiatCurrency: string): Promise<{ value: string; exchangeRate: string }> {
    const data = await this.api.get(`crypto/${checkedPath(coin)}/convert.php`, {
      from: String(fiatCurrency ?? '').trim().toLowerCase(),
      value: formatAmount(amount),
    });
    if (typeof data.value_coin !== 'string' && typeof data.value_coin !== 'number') {
      throw new ApiError(`PayGate.to could not convert ${String(fiatCurrency).toUpperCase()} to ${coinId(coin)}.`, 200, JSON.stringify(data));
    }
    return { value: plainNumber(data.value_coin), exchangeRate: plainNumber(data.exchange_rate) };
  }

  /** Create the receiving address for one order (GET /crypto/{coin}/wallet.php). */
  async createWallet(coin: string, payoutWallet: string, callbackUrl: string, options: WalletOptions = {}): Promise<CryptoWallet> {
    return this.requestWallet(coin, 'wallet.php', {
      address: validateWallet(payoutWallet, 'Payout wallet'),
      callback: validateCallback(callbackUrl),
      ...walletOptions(options),
    });
  }

  /**
   * White-label: split each payment with an affiliate wallet. Without fees the affiliate earns the
   * default commission (affiliate.php). With fees, affiliateFee + merchantFee must equal 0.99.
   */
  async createAffiliateWallet(
    coin: string,
    payoutWallet: string,
    callbackUrl: string,
    affiliateWallet: string,
    fees?: { affiliateFee: Amount; merchantFee: Amount },
    options: WalletOptions = {},
  ): Promise<CryptoWallet> {
    const query: Record<string, string> = {
      address: validateWallet(payoutWallet, 'Payout wallet'),
      callback: validateCallback(callbackUrl),
      affiliate: validateWallet(affiliateWallet, 'Affiliate wallet'),
    };
    if (!fees) {
      return this.requestWallet(coin, 'affiliate.php', { ...query, ...walletOptions(options) });
    }
    query.affiliate_fee = validateShare(fees.affiliateFee, 'affiliateFee');
    query.merchant_fee = validateShare(fees.merchantFee, 'merchantFee');
    assertShares([query.affiliate_fee, query.merchant_fee]);
    return this.requestWallet(coin, 'custom-affiliate.php', { ...query, ...walletOptions(options) });
  }

  /** Split each payment across up to 19 wallets (POST /crypto/{coin}/mass-payout.php). Shares must total 0.99. */
  async createMassPayoutWallet(coin: string, callbackUrl: string, shares: Record<string, Amount>, options: WalletOptions = {}): Promise<CryptoWallet> {
    const path = `crypto/${checkedPath(coin)}/mass-payout.php`;
    const data = await this.api.postJson(path, { callback: validateCallback(callbackUrl), fees: validateShares(shares) }, walletOptions(options));
    return toWallet(coin, data, path);
  }

  /** Blockchain fee for a mass payout to walletCount wallets. */
  async massPayoutFees(coin: string, walletCount: number): Promise<{ feeCoin: string; feeFiat: Record<string, string> }> {
    if (!Number.isInteger(walletCount) || walletCount < 1 || walletCount > 19) {
      throw new InvalidArgumentError('walletCount must be between 1 and 19.');
    }
    const data = success(await this.api.get(`crypto/${checkedPath(coin)}/mass-payout-fees.php`, { wallet_count: walletCount }), 'mass payout fees');
    return { feeCoin: plainNumber(data.estimated_cost), feeFiat: stringMap(data.estimated_cost_currency) };
  }

  /** QR code for a receiving address (GET /crypto/{coin}/qrcode.php). */
  async qrCode(coin: string, address: string, amount?: Amount): Promise<{ pngBase64: string; dataUri: string; paymentUri: string }> {
    const query: Record<string, string> = { address: validateWallet(address, 'Address') };
    if (amount !== undefined && amount !== null && amount !== '') {
      query.amount = formatAmount(amount);
    }
    const data = await this.api.get(`crypto/${checkedPath(coin)}/qrcode.php`, query);
    if (typeof data.qr_code !== 'string' || data.qr_code === '') {
      throw new ApiError('PayGate.to did not return a QR code.', 200, JSON.stringify(data));
    }
    return {
      pngBase64: data.qr_code,
      dataUri: 'data:image/png;base64,' + data.qr_code,
      paymentUri: String(data.payment_uri ?? address),
    };
  }

  /**
   * Prepare the hosted multi-coin page for one order (POST /crypto/multi-hosted-wallet.php).
   * wallets: network => your wallet (see HOSTED_NETWORKS). Networks left out are not offered.
   */
  async createHostedWallet(wallets: Partial<Record<HostedNetwork, string>>, fiatAmount: Amount, fiatCurrency: string, callbackUrl: string): Promise<HostedWallet> {
    const payload: Record<string, unknown> = {};
    for (const [rawNetwork, address] of Object.entries(wallets ?? {})) {
      const network = rawNetwork.trim().toLowerCase();
      if (!(HOSTED_NETWORKS as readonly string[]).includes(network)) {
        throw new InvalidArgumentError(`Unknown network "${network}". Use: ${HOSTED_NETWORKS.join(', ')}.`);
      }
      if (address === undefined || address === null || String(address).trim() === '') {
        continue;
      }
      payload[network] = validateWallet(String(address), `${network} wallet`);
    }
    if (Object.keys(payload).length === 0) {
      throw new InvalidArgumentError('Give at least one network wallet.');
    }
    payload.fiat_amount = Number(formatAmount(fiatAmount, 'Fiat amount'));
    payload.fiat_currency = String(fiatCurrency ?? '').trim().toUpperCase();
    payload.callback = validateCallback(callbackUrl);

    const data = await this.api.postJson('crypto/multi-hosted-wallet.php', payload);
    if (typeof data.payment_token !== 'string' || data.payment_token === '') {
      throw new ApiError('PayGate.to did not return a payment_token. Check the wallets.', 200, JSON.stringify(data));
    }
    return { paymentToken: data.payment_token, callbackUrl: String(data.callback_url ?? ''), ipnToken: String(data.ipn_token ?? ''), raw: data };
  }

  /** Link to the hosted multi-coin page. addFees: the customer also pays the estimated network fee. */
  hostedPaymentUrl(wallet: HostedWallet | string, options: { addFees?: boolean; branding?: Branding } = {}): string {
    const token = typeof wallet === 'string' ? wallet : wallet?.paymentToken;
    if (!token || token.trim() === '') {
      throw new InvalidArgumentError('payment_token is empty: create the hosted wallet first.');
    }
    const query = { payment_token: token, add_fees: options.addFees ? '1' : '0', ...validateBranding(options.branding) };
    return `https://${this.checkoutHost}/crypto/hosted.php${queryString(query, ['payment_token'])}`;
  }

  /**
   * Payment status for occasional checks (GET /crypto/payment-status.php). Rate limited:
   * update orders from the signed callback, not from this.
   */
  async paymentStatus(ipnToken: string, coin: string): Promise<CryptoPaymentStatus> {
    const token = String(ipnToken ?? '').trim();
    if (token === '') {
      throw new InvalidArgumentError('ipn_token is empty.');
    }
    const data = await this.api.get('crypto/payment-status.php', { ipn_token: token, ticker: checkedPath(coin) }, ['ipn_token']);
    const status = String(data.status ?? '');
    return {
      status,
      paid: status.toLowerCase() === 'paid',
      valueCoin: plainNumber(data.value_coin),
      txidIn: String(data.txid_in ?? ''),
      txidOut: String(data.txid_out ?? ''),
      coin: String(data.coin ?? ''),
    };
  }

  /** Coins that can be swapped (GET /crypto/swap-info.php), as paths such as "trc20/usdt". */
  async swapCoins(): Promise<string[]> {
    const data = await this.api.get('crypto/swap-info.php');
    return Array.isArray(data.tickers) ? data.tickers.map(String) : [];
  }

  /**
   * Create a swap: the customer sends `amount` of fromCoin and toWallet receives toCoin
   * (GET /crypto/{from}/swap.php, or aff-swap.php with an affiliate). Returns the API response.
   */
  async createSwap(
    fromCoin: string,
    toCoin: string,
    toWallet: string,
    amount: Amount,
    callbackUrl: string,
    affiliate?: { wallet: string; fee: Amount },
  ): Promise<Record<string, any>> {
    const query: Record<string, string> = {
      address: validateWallet(toWallet, 'Receiving wallet'),
      callback: validateCallback(callbackUrl),
      amount: formatAmount(amount),
      ticker_to: checkedPath(toCoin),
    };
    let endpoint = 'swap.php';
    if (affiliate) {
      query.affiliate_fee = validateShare(affiliate.fee, 'affiliate fee');
      query.affiliate = validateWallet(affiliate.wallet, 'Affiliate wallet');
      endpoint = 'aff-swap.php';
    }
    // Not retried: every call creates a new exchange.
    return this.api.get(`crypto/${checkedPath(fromCoin)}/${endpoint}`, query, [], false);
  }

  /** Status of a swap (GET /crypto/control/swap-status.php). For occasional checks. */
  async swapStatus(exchangeId: string): Promise<Record<string, any>> {
    const id = String(exchangeId ?? '').trim();
    if (id === '') {
      throw new InvalidArgumentError('exchange_id is empty.');
    }
    return this.api.get('crypto/control/swap-status.php', { exchange_id: id });
  }

  private async requestWallet(coin: string, endpoint: string, query: Record<string, string>): Promise<CryptoWallet> {
    const path = `crypto/${checkedPath(coin)}/${endpoint}`;
    return toWallet(coin, await this.api.get(path, query), path);
  }
}

function toWallet(coin: string, data: Record<string, any>, path: string): CryptoWallet {
  if (typeof data.address_in !== 'string' || data.address_in === '') {
    throw new ApiError(`PayGate.to did not return an address_in for ${path}. Check the payout wallet matches the coin.`, 200, JSON.stringify(data));
  }
  return { coin: coinId(coin), addressIn: data.address_in, callbackUrl: String(data.callback_url ?? ''), ipnToken: String(data.ipn_token ?? ''), raw: data };
}

/** Endpoints documented with "status": "success": any other status is a failure. */
function success(data: Record<string, any>, what: string): Record<string, any> {
  const status = typeof data.status === 'string' ? data.status.toLowerCase() : 'success';
  if (status !== 'success' || data.estimated_cost === undefined) {
    throw new ApiError(`PayGate.to could not estimate the ${what}.`, 200, JSON.stringify(data));
  }
  return data;
}

function walletOptions(options: WalletOptions): Record<string, string> {
  const unknown = Object.keys(options ?? {}).filter((key) => key !== 'pending' && key !== 'confirmations');
  if (unknown.length > 0) {
    throw new InvalidArgumentError(`Unknown wallet option(s): ${unknown.join(', ')}. Use pending, confirmations.`);
  }
  const out: Record<string, string> = {};
  if (options?.pending) {
    out.pending = '1';
  }
  if (options?.confirmations !== undefined) {
    const count = Math.trunc(Number(options.confirmations));
    if (!(count >= 1)) {
      throw new InvalidArgumentError('confirmations must be at least 1.');
    }
    out.confirmations = String(count);
  }
  return out;
}

function coinFrom(ticker: string, chain: string, entry: Record<string, any>): Coin {
  const t = ticker.toLowerCase();
  const c = chain.toLowerCase();
  const id = c === '' ? t : `${c}_${t}`;
  const name = String(entry.coin ?? t.toUpperCase());
  const minimum = entry.minimum_transaction_coin ?? entry.minimum;
  return {
    id,
    path: coinPath(id),
    ticker: t,
    chain: c,
    name,
    label: c === '' ? name : `${name} (${c.toUpperCase()})`,
    logo: String(entry.logo ?? ''),
    minimum: minimum === undefined || minimum === '' ? '' : plainNumber(minimum),
  };
}
