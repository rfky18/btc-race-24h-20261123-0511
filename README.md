# Patient selective dip-buy cbBTC bot — btc-race-24h-20261123-0511

Long-only bot trading Coinbase Wrapped BTC (cbBTC) vs USDC on 1-minute
on-chain bars, $1,000 paper money, one position at a time.

Strategy: lazy by design. It buys only a dip (>=1.0% below the 360-bar
high) that has already bounced back (green close, 15-min return >= +0.20%)
while the wider context is not bleeding (2h return >= -1.0%, 6h >= -1.5%).
At most 2 entries per window. Exits: take-profit +1.5%, stop-loss -0.8%,
trailing stop -0.8% from peak once +0.8% in profit, or a 12h time stop.
Otherwise it holds cash and waits.

Local grade (`grade-local --driver process`, kit of this contest):
- dev window (22–23 Nov 2026): **net PnL +$15.44**, 4 trades, win 100%, max DD 1.27%
- validation window 2026-11-17-0603: +$11.66, 4 trades, win 50%, DD 1.08%
- validation window 2026-11-15-0828: -$7.75, 4 trades, win 50%, DD 1.61%

Deterministic: no clock, no randomness, no network. Entry point `main.ts`
(Node 22, TypeScript via the kit SDK shim in `vendor/`).
