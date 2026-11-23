// Patient selective dip-buy bot for cbBTC, 1-minute bars, long only.
//
// Idea (written from scratch for this contest): BTC drifts and chops most
// of the day, so the bot is lazy on purpose. It only buys a dip that has
// already started to bounce back, only when the wider context is not
// bleeding, and it gets out fast: a small take-profit, a tight stop, a
// trailing exit once the trade is working, and a hard time stop. At most
// two entries per window, one position at a time, full cash each time.
// When nothing matches it simply holds cash and waits.
//
// Rules, all evaluated on the bar that just closed (fills land at the
// next bar's open, so every decision is one bar late by construction):
//   entry: dip >= 1.0% below the 360-bar high, last close green,
//          15-min return >= +0.20% (bounce confirmed), 2h return >= -1.0%
//          and 6h return >= -1.5% (no buying into a bleed), at least
//          360 bars of history, cooldown 120 bars after an exit.
//   exit:  take-profit +1.5%, stop-loss -0.8%, trailing stop -0.8% from
//          the peak once the peak is +0.8% above entry, or 720 bars
//          (12h) without an exit, whichever comes first.
// Deterministic: no clock, no randomness, no environment reads; every
// decision is a pure function of the bars seen so far.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const DIP_BPS = 100; // 1.0% below the 360-bar high
const BOUNCE_BPS = 20; // 15-min return at least +0.20%
const RET_2H_MIN_BPS = -100; // do not buy into a >1% two-hour bleed
const RET_6H_MIN_BPS = -150; // do not buy into a >1.5% six-hour bleed
const TP_BPS = 150; // take profit +1.5%
const SL_BPS = 80; // stop loss -0.8%
const TRAIL_ARM_BPS = 80; // trailing exit arms at +0.8% peak
const TRAIL_BPS = 80; // trailing exit -0.8% from the peak
const TIME_EXIT_BARS = 720; // 12 hours, then out whatever the price
const MAX_ENTRIES = 2;
const COOLDOWN_BARS = 120;
const HISTORY_BARS = 360;
const MAX_SLIPPAGE_BPS = 300; // 3%: covers the open move plus fees/impact

// Closes in USDC, oldest first. One float per bar is enough: all
// decisions are ratios, and the ratios are far above float noise.
const closes: number[] = [];
let entries = 0;
let lastExitSeq = -1000000;
let entryPrice = 0; // USDC per cbBTC, from the buy fill
let entrySeq = -1;
let peakPrice = 0;

function priceOf(state: BarsState, raw: string): number {
  const scale = state.symbols.get(SYMBOL)?.price_scale ?? 8;
  return Number(BigInt(raw)) / 10 ** scale;
}

function retBps(now: number, barsAgo: number): number {
  const i = closes.length - 1 - barsAgo;
  if (i < 0) return 0;
  const old = closes[i];
  if (old <= 0) return 0;
  return ((now - old) / old) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = priceOf(state, bar.c);
    closes.push(close);

    // Learn the entry price (and reset the peak) from the buy fill.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
      if (fill.side === "buy") {
        entryPrice = priceOf(state, fill.price);
        entrySeq = state.seq;
        peakPrice = entryPrice;
      } else {
        lastExitSeq = state.seq;
        entryPrice = 0;
        entrySeq = -1;
        peakPrice = 0;
      }
    }

    if (state.warmingUp) return [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;

    // --- exit: one open position at a time -------------------------
    if (qty > 0n && entryPrice > 0) {
      if (close > peakPrice) peakPrice = close;
      const gainBps = ((close - entryPrice) / entryPrice) * 10000;
      const trailArmed = peakPrice >= entryPrice * (1 + TRAIL_ARM_BPS / 10000);
      const trailHit = trailArmed && close <= peakPrice * (1 - TRAIL_BPS / 10000);
      const timedOut = entrySeq >= 0 && state.seq - entrySeq >= TIME_EXIT_BARS;
      if (gainBps >= TP_BPS || gainBps <= -SL_BPS || trailHit || timedOut) {
        return [
          {
            side: "sell",
            symbol: SYMBOL,
            qty: qty.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }
    if (qty > 0n) return []; // position without a known entry: hold, never add

    // --- entry: patient dip-buy only -------------------------------
    if (entries >= MAX_ENTRIES) return [];
    if (closes.length < HISTORY_BARS + 1) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (state.cash <= 0n) return [];

    let high360 = 0;
    for (let i = closes.length - 361; i < closes.length; i++) {
      if (closes[i] > high360) high360 = closes[i];
    }
    const dipBps = ((high360 - close) / high360) * 10000;
    const prevClose = closes[closes.length - 2];
    const green = close > prevClose;
    const bounceBps = retBps(close, 15);
    const ret2hBps = retBps(close, 120);
    const ret6hBps = retBps(close, 360);
    const impact = state.impactBps(SYMBOL, state.cash);
    // A full-size buy moves its own fill price; refuse it when the
    // pool is too thin that day (impact above 25 bps), because the
    // round trip then costs more than the take-profit is worth.
    if (impact !== null && impact > 250n) return []; // pool too thin for us

    if (
      dipBps >= DIP_BPS &&
      green &&
      bounceBps >= BOUNCE_BPS &&
      ret2hBps >= RET_2H_MIN_BPS &&
      ret6hBps >= RET_6H_MIN_BPS
    ) {
      entries += 1;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: state.cash.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  },
});
