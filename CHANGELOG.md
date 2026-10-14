# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-14

### Added
- Card payments: wallets (standard, affiliate, sub-affiliate, mass payout), hosted and
  provider-specific payment links with white-label branding, provider list, USD conversion,
  payment status.
- Crypto payments: coin list, coin info and prices, network fees, conversion, wallets with
  pending notices and confirmation count, affiliate and mass-payout wallets, QR codes, hosted
  multi-coin page, payment status, swaps.
- Callback verification against PayGate.to's RSA signature, with the published `v1` key bundled
  and a resolver for future keys. Works with Express and Node's `http` module.
- `CallbackData` for the payment parameters, including exact per-address payouts.
- `CallbackToken` to tie each callback to an order with an HMAC (compatible with the PHP SDK).
- ESM and CommonJS builds with TypeScript types. No dependencies.
- Examples: an Express shop with card, on-site crypto and hosted checkouts, and a callback handler.
