import { ApiError, InvalidArgumentError } from './errors.js';
import type { Requester } from './http.js';
import {
  assertShares,
  formatAmount,
  queryString,
  validateBranding,
  validateCallback,
  validateShare,
  validateShares,
  validateWallet,
  type Amount,
  type Branding,
} from './support.js';

/** The wallet created for one card order. */
export interface CardWallet {
  /** Encrypted address for the payment link, already URL-encoded by PayGate.to. */
  addressIn: string;
  /** The order's Polygon deposit address (matches address_in in the callback). */
  polygonAddressIn: string;
  callbackUrl: string;
  /** For paymentStatus(). */
  ipnToken: string;
  /** The full API response. */
  raw: Record<string, unknown>;
}

/** A card provider from providers(). */
export interface CardProvider {
  /** Value for the provider argument of paymentUrl(), e.g. "wert". */
  id: string;
  name: string;
  status: string;
  active: boolean;
  minimumCurrency: string;
  minimumAmount: string;
}

export interface CardPaymentStatus {
  status: string;
  paid: boolean;
  valueCoin: string;
  txidOut: string;
  coin: string;
}

export interface PaymentUrlOptions {
  /** Send the customer straight to one provider (see providers()). */
  provider?: string;
  /** Hosted multi-provider page only. */
  branding?: Branding;
}

/**
 * Card payments: Visa, Mastercard, Apple Pay, Google Pay and more, paid out in USDC on Polygon.
 *
 *   const wallet = await paygate.card.createWallet('0xYourUsdcWallet', callbackUrl);
 *   res.redirect(paygate.card.paymentUrl(wallet, 49.9, 'buyer@example.com', 'EUR'));
 */
export class CardApi {
  /** @internal Use client.card. */
  constructor(private readonly api: Requester, private readonly checkoutHost: string) {}

  /**
   * Create the wallet for one order (GET /control/wallet.php). The same callback URL always
   * returns the same wallet.
   */
  async createWallet(payoutWallet: string, callbackUrl: string): Promise<CardWallet> {
    return this.requestWallet('control/wallet.php', {
      address: validateWallet(payoutWallet, 'Payout wallet'),
      callback: validateCallback(callbackUrl),
    });
  }

  /**
   * White-label: split each payout with an affiliate wallet. Without fees the affiliate earns the
   * default commission (affiliate.php). With fees, affiliateFee + merchantFee must equal 0.99
   * (custom-affiliate.php).
   */
  async createAffiliateWallet(
    payoutWallet: string,
    callbackUrl: string,
    affiliateWallet: string,
    fees?: { affiliateFee: Amount; merchantFee: Amount },
  ): Promise<CardWallet> {
    const query: Record<string, string> = {
      address: validateWallet(payoutWallet, 'Payout wallet'),
      callback: validateCallback(callbackUrl),
      affiliate: validateWallet(affiliateWallet, 'Affiliate wallet'),
    };
    if (!fees) {
      return this.requestWallet('control/affiliate.php', query);
    }
    query.affiliate_fee = validateShare(fees.affiliateFee, 'affiliateFee');
    query.merchant_fee = validateShare(fees.merchantFee, 'merchantFee');
    assertShares([query.affiliate_fee, query.merchant_fee]);
    return this.requestWallet('control/custom-affiliate.php', query);
  }

  /**
   * White-label with a sub-affiliate (GET /control/custom-sub-affiliate.php).
   * affiliateFee + subAffiliateFee + merchantFee must equal 0.99.
   */
  async createSubAffiliateWallet(
    payoutWallet: string,
    callbackUrl: string,
    affiliateWallet: string,
    subAffiliateWallet: string,
    fees: { affiliateFee: Amount; subAffiliateFee: Amount; merchantFee: Amount },
  ): Promise<CardWallet> {
    const query: Record<string, string> = {
      address: validateWallet(payoutWallet, 'Payout wallet'),
      callback: validateCallback(callbackUrl),
      affiliate: validateWallet(affiliateWallet, 'Affiliate wallet'),
      affiliate_fee: validateShare(fees?.affiliateFee, 'affiliateFee'),
      merchant_fee: validateShare(fees?.merchantFee, 'merchantFee'),
      sub_affiliate_fee: validateShare(fees?.subAffiliateFee, 'subAffiliateFee'),
      sub_affiliate: validateWallet(subAffiliateWallet, 'Sub-affiliate wallet'),
    };
    assertShares([query.affiliate_fee, query.merchant_fee, query.sub_affiliate_fee]);
    return this.requestWallet('control/custom-sub-affiliate.php', query);
  }

  /** Split each payout across up to 19 wallets (POST /control/mass-payout.php). Shares must total 0.99. */
  async createMassPayoutWallet(callbackUrl: string, shares: Record<string, Amount>): Promise<CardWallet> {
    const fees = validateShares(shares);
    const data = await this.api.postJson('control/mass-payout.php', { callback: validateCallback(callbackUrl), fees });
    return toWallet(data, 'control/mass-payout.php');
  }

  /**
   * Link that sends the customer to pay: the hosted multi-provider page (pay.php), or one provider
   * directly (process-payment.php) when options.provider is set.
   */
  paymentUrl(wallet: CardWallet | string, amount: Amount, email: string, currency: string, options: PaymentUrlOptions = {}): string {
    const addressIn = typeof wallet === 'string' ? wallet : wallet?.addressIn;
    if (!addressIn || addressIn.trim() === '') {
      throw new InvalidArgumentError('address_in is empty: create the wallet first.');
    }
    const customer = String(email ?? '').trim();
    if (customer === '' || !customer.includes('@')) {
      throw new InvalidArgumentError('A valid customer email address is required.');
    }
    const code = String(currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new InvalidArgumentError(`Currency "${code}" must be a three-letter ISO code such as USD.`);
    }
    const value = formatAmount(amount);

    if (options.provider) {
      if (options.branding && Object.keys(options.branding).length > 0) {
        throw new InvalidArgumentError('Branding options only apply to the hosted multi-provider page (no provider).');
      }
      const query = { address: addressIn, amount: value, provider: options.provider.trim(), email: customer, currency: code };
      return `https://${this.checkoutHost}/process-payment.php${queryString(query, ['address'])}`;
    }
    const query = { address: addressIn, amount: value, email: customer, currency: code, ...validateBranding(options.branding) };
    return `https://${this.checkoutHost}/pay.php${queryString(query, ['address'])}`;
  }

  /** All card providers with their status and minimum order (GET /control/provider-status). */
  async providers(): Promise<CardProvider[]> {
    const data = await this.api.get('control/provider-status');
    const list: unknown[] = Array.isArray(data.providers) ? data.providers : [];
    return list
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && 'id' in row)
      .map((row) => {
        const status = String(row.status ?? '');
        return {
          id: String(row.id),
          name: String(row.provider_name ?? row.id),
          status,
          active: status.toLowerCase() === 'active',
          minimumCurrency: String(row.minimum_currency ?? ''),
          minimumAmount: row.minimum_amount === undefined ? '' : String(row.minimum_amount),
        };
      });
  }

  /** Convert an amount to USD (GET /control/convert.php). Some providers accept USD only. */
  async convertToUsd(amount: Amount, fromCurrency: string): Promise<{ value: string; exchangeRate: string }> {
    const from = String(fromCurrency ?? '').trim().toUpperCase();
    const value = formatAmount(amount);
    if (from === 'USD') {
      return { value, exchangeRate: '1' };
    }
    const data = await this.api.get('control/convert.php', { from, value });
    if (typeof data.value_coin !== 'string' && typeof data.value_coin !== 'number') {
      throw new ApiError(`PayGate.to could not convert ${from} to USD.`, 200, JSON.stringify(data));
    }
    return { value: String(data.value_coin), exchangeRate: data.exchange_rate === undefined ? '' : String(data.exchange_rate) };
  }

  /**
   * Payment status for occasional checks (GET /control/payment-status.php). Rate limited:
   * update orders from the signed callback, not from this.
   */
  async paymentStatus(ipnToken: string): Promise<CardPaymentStatus> {
    const token = String(ipnToken ?? '').trim();
    if (token === '') {
      throw new InvalidArgumentError('ipn_token is empty.');
    }
    const data = await this.api.get('control/payment-status.php', { ipn_token: token }, ['ipn_token']);
    const status = String(data.status ?? '');
    return {
      status,
      paid: status.toLowerCase() === 'paid',
      valueCoin: String(data.value_coin ?? ''),
      txidOut: String(data.txid_out ?? ''),
      coin: String(data.coin ?? ''),
    };
  }

  private async requestWallet(path: string, query: Record<string, string>): Promise<CardWallet> {
    return toWallet(await this.api.get(path, query), path);
  }
}

function toWallet(data: Record<string, any>, path: string): CardWallet {
  if (typeof data.address_in !== 'string' || data.address_in === '') {
    throw new ApiError(`PayGate.to did not return an address_in for ${path}. Check the payout wallet.`, 200, JSON.stringify(data));
  }
  return {
    addressIn: data.address_in,
    polygonAddressIn: String(data.polygon_address_in ?? ''),
    callbackUrl: String(data.callback_url ?? ''),
    ipnToken: String(data.ipn_token ?? ''),
    raw: data,
  };
}
