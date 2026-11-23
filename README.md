# btc-race-bot-2

[make.fun · btc-race-24h-20261123-0511](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[rank](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[reward](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
![Node 22](https://img.shields.io/badge/node-22-green)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Competition](https://img.shields.io/badge/make.fun-btc--race--24h-orange)

A paper-money trading bot for the make.fun **btc-race-24h-20261123-0511**
competition ("Race a BTC trading bot live for 24 hours"). It trades cbBTC
against USDC, minute by minute, in a replay of on-chain prices, starting
from 1,000 USDC of paper money. Nothing here trades for real.

## Strategy

Two modes that never fight each other:

- **Trend** — when the last 15 minutes are up at least +10 bps and the last
  hour at least +60 bps, the bot buys with its whole balance and rides. The
  only exit is a hard stop 60 bps under the entry price; otherwise the
  position is held to the end of the window. No take-profit, trailing stop
  or RSI exit — on a drifting window those only chop the ride into losses.
- **Dip** — a mean-reversion mode fenced behind a regime gate: it arms only
  while the last hour is down more than 50 bps. It buys a 15-minute dip of
  at least 50 bps when RSI(14) is at most 40 and the last 3 minutes have
  stopped falling (or the dip is extreme, 120 bps or more). Exits at +90
  bps, -35 bps, RSI 65, or after 20 bars.

Both modes size all-in, bounded by the position weight cap: round-trip
costs run to roughly 46 bps, so half-measures do not clear them.

The bot is a pure function of the bars it has seen — no clock, no
randomness — so repeated runs produce identical action logs.

## Layout

- `main.ts` — the bot. It speaks the `agent-fun/bars-replay/v1` protocol
  through the vendored shim and is run by the grader as `node main.ts`.
- `vendor/makefun-bars.ts` — the make.fun bars SDK shim, copied from the
  competition kit.

## Licence

MIT — see `LICENSE`.
