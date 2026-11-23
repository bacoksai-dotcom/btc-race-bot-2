// Two-mode cbBTC/USDC race bot (agent-fun/bars-replay/v1).
//
// The dev window for this race rises early and then drifts sideways: the
// drift is where the money is, and dips in it barely rebound, so the bot is
// built around two modes that never fight each other:
//
//   TREND — when the last 15 minutes are up at least +10 bps and the last
//   hour at least +60 bps, buy with the whole balance and simply ride. The
//   only exit is a hard stop 60 bps under the entry price (a momentum entry
//   that reverses that far was a failed breakout); otherwise the position
//   is held until the replay flattens it at the end of the window. No
//   take-profit, no trailing stop, no RSI exit: every exit rule tested on
//   this kind of window chops the ride into losses.
//
//   DIP — the mean-reversion mode, kept from the earlier dip-buyer design
//   but fenced behind a regime gate: it may only arm while the last hour is
//   down more than 50 bps. It buys a 15-minute dip of at least 50 bps when
//   RSI(14) is at most 40 and the last 3 minutes have stopped falling
//   (better than -5 bps), unless the dip is extreme (120 bps or more),
//   which may be bought even mid-freefall. Exits: take profit at +90 bps,
//   stop at -35 bps, RSI at 65 or over, or a 20-bar time stop.
//
// Sizing is all-in (bounded by the weight cap) in both modes: round-trip
// costs are ~46 bps, so half-measures do not clear them. Everything is a
// pure function of the bars seen so far — no clock, no randomness — so the
// two grading runs produce identical action logs.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const WIDE_SLIPPAGE_BPS = 10_000;

// Windows, in bars (one bar is one minute).
const FAST_BARS = 15;
const SLOW_BARS = 60;
const SHORT_BARS = 3;
const RSI_PERIOD = 14;

// Trend mode thresholds, in basis points.
const TREND_FAST_MIN_BPS = 10;
const TREND_SLOW_MIN_BPS = 60;
const TREND_STOP_BPS = 60;

// Dip mode thresholds, in basis points unless noted.
const DIP_REGIME_MAX_BPS = -50;
const DIP_TRIGGER_BPS = -50;
const DIP_EXTREME_BPS = -120;
const DIP_SETTLE_MIN_BPS = -5;
const DIP_RSI_MAX = 40;
const DIP_TAKE_PROFIT_BPS = 90;
const DIP_STOP_BPS = -35;
const DIP_RSI_EXIT = 65;
const DIP_TIME_STOP_BARS = 20;

type Mode = 'trend' | 'dip';

/** Close prices of every bar of the symbol seen so far, oldest first. */
const closes: number[] = [];

/** Return over the last `back` bars, in bps; null until enough history. */
function returnBps(back: number): number | null {
  if (closes.length <= back) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - back]!;
  return ((now - then) / then) * 10_000;
}

/** Wilder-smoothed RSI over the close history; null until it is seeded. */
function rsi(period: number): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// Position bookkeeping, reconstructed from fills as they arrive.
let mode: Mode | null = null;
let awaiting: Mode | null = null;
let entryPrice = 0;
let entrySeq = -1;

await runBars({
  onBatch(state, batch) {
    // Fold this batch's fills into the position bookkeeping first: a buy
    // fill opens a position in the mode that ordered it, a sell fill that
    // empties the position closes the mode out.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        mode = awaiting ?? mode ?? 'trend';
        awaiting = null;
        entryPrice = Number(fill.price);
        entrySeq = state.seq;
      } else if ((state.positions.get(SYMBOL)?.qty ?? 0n) === 0n) {
        mode = null;
      }
    }

    // Only act on batches that carried a fresh bar for the symbol; the
    // close history is indexed by bars seen, not by batches.
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    if (!fresh) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(Number(close));
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    if (holding) {
      if (entryPrice <= 0) return [];
      const pnlBps = ((Number(close) - entryPrice) / entryPrice) * 10_000;
      let exit = false;
      if (mode === 'dip') {
        const r = rsi(RSI_PERIOD);
        exit =
          pnlBps >= DIP_TAKE_PROFIT_BPS ||
          pnlBps <= DIP_STOP_BPS ||
          (r !== null && r >= DIP_RSI_EXIT) ||
          state.seq - entrySeq >= DIP_TIME_STOP_BARS;
      } else {
        // Trend positions answer to the hard stop and nothing else.
        exit = pnlBps <= -TREND_STOP_BPS;
      }
      if (!exit) return [];
      const order: SellInput = {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: WIDE_SLIPPAGE_BPS,
      };
      return [order];
    }

    if (awaiting !== null) return [];

    const fast = returnBps(FAST_BARS);
    const slow = returnBps(SLOW_BARS);
    if (fast === null || slow === null) return [];

    let enter: Mode | null = null;
    if (fast >= TREND_FAST_MIN_BPS && slow >= TREND_SLOW_MIN_BPS) {
      enter = 'trend';
    } else if (slow < DIP_REGIME_MAX_BPS && fast <= DIP_TRIGGER_BPS) {
      const r = rsi(RSI_PERIOD);
      const short = returnBps(SHORT_BARS);
      const settled = short !== null && short >= DIP_SETTLE_MIN_BPS;
      if (r !== null && r <= DIP_RSI_MAX && (settled || fast <= DIP_EXTREME_BPS)) {
        enter = 'dip';
      }
    }
    if (enter === null) return [];

    // All-in, bounded by the position weight cap and the cash on hand.
    // (The fee comes out of the notional, so the full balance is the spend.)
    const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
    const notional = state.cash < byWeight ? state.cash : byWeight;
    if (notional <= 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    awaiting = enter;
    const order: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: notional,
      max_slippage_bps: WIDE_SLIPPAGE_BPS,
    };
    return [order];
  },
});
