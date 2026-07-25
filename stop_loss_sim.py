#!/usr/bin/env python3
"""
Monte Carlo for a flat-stake college basketball betting plan with a hard stop loss.

Mandate being tested:
    unit        = $10 per game
    stop loss   = -$40 cumulative (session ends, absorbing barrier)
    price       = -110 standard point-spread / total juice

The point of the model: a $40 stop loss at a $10 unit is only 4 units of
buffer. This quantifies how often that buffer gets taken out at various
long-run win rates, and how much a smaller unit or a stop-win rule helps.

Pure stdlib, no numpy. Run: python3 stop_loss_sim.py
"""

import random
from statistics import mean, median

TRIALS = 200_000
SEED = 20270405  # 2027 national championship game date, Detroit

# ---------------------------------------------------------------- pricing


def payout(american_odds: int) -> float:
    """Profit on a 1-unit win at the given American price."""
    if american_odds < 0:
        return 100.0 / abs(american_odds)
    return american_odds / 100.0


def breakeven(american_odds: int) -> float:
    """Win rate needed to break even at the given price."""
    p = payout(american_odds)
    return 1.0 / (1.0 + p)


# ---------------------------------------------------------------- session


def run_session(win_rate, unit, stop_loss, stop_win, price, max_bets, rng,
                win_multiple=None):
    """
    Play until one barrier is hit or max_bets is exhausted.
    Returns (final_pl, bets_placed, outcome) where outcome is one of
    'stop_loss' | 'stop_win' | 'horizon'.

    win_multiple overrides the price-derived payout, for parlays and other
    prices that aren't a single American number.
    """
    mult = win_multiple if win_multiple is not None else payout(price)
    profit_per_win = unit * mult
    pl = 0.0
    for n in range(1, max_bets + 1):
        pl += profit_per_win if rng.random() < win_rate else -unit
        if pl <= stop_loss:
            return pl, n, "stop_loss"
        if stop_win is not None and pl >= stop_win:
            return pl, n, "stop_win"
    return pl, max_bets, "horizon"


def simulate(win_rate, unit=10.0, stop_loss=-40.0, stop_win=None,
             price=-110, max_bets=40, trials=TRIALS, seed=SEED,
             win_multiple=None):
    rng = random.Random(seed)
    pls, lens, outcomes = [], [], []
    for _ in range(trials):
        pl, n, outcome = run_session(win_rate, unit, stop_loss, stop_win,
                                     price, max_bets, rng, win_multiple)
        pls.append(pl)
        lens.append(n)
        outcomes.append(outcome)
    return {
        "win_rate": win_rate,
        "unit": unit,
        "max_bets": max_bets,
        "p_stop_loss": outcomes.count("stop_loss") / trials,
        "p_stop_win": outcomes.count("stop_win") / trials,
        "mean_pl": mean(pls),
        "median_pl": median(pls),
        "mean_bets": mean(lens),
        "p_profit": sum(1 for x in pls if x > 0) / trials,
    }


# ---------------------------------------------------------------- reports

RATES = [0.500, 0.524, 0.550, 0.575, 0.600]


def hdr(title):
    print()
    print(title)
    print("-" * len(title))


def table(rows, stop_win_col=False):
    cols = "  win%   P(hit -$40)  " + ("P(hit +$40)  " if stop_win_col else "")
    cols += "P(up)   mean P/L  median P/L  avg bets"
    print(cols)
    for r in rows:
        line = f"  {r['win_rate']*100:4.1f}%  {r['p_stop_loss']*100:9.1f}%  "
        if stop_win_col:
            line += f"{r['p_stop_win']*100:9.1f}%  "
        line += (f"{r['p_profit']*100:5.1f}%  "
                 f"{r['mean_pl']:+8.2f}  {r['median_pl']:+10.2f}  "
                 f"{r['mean_bets']:7.1f}")
        print(line)


def main():
    print(f"Monte Carlo: {TRIALS:,} sessions per scenario, price -110 "
          f"(breakeven {breakeven(-110)*100:.2f}%)")

    hdr("A. Mandate as written: $10 unit, -$40 stop, no stop-win, 40-game horizon")
    table([simulate(p) for p in RATES])

    hdr("B. Same, but a full season of volume (150 games)")
    table([simulate(p, max_bets=150) for p in RATES])

    hdr("C. $10 unit, -$40 stop AND +$40 stop-win (reset the session on either)")
    table([simulate(p, stop_win=40.0, max_bets=150) for p in RATES],
          stop_win_col=True)

    hdr("D. Halving the unit to $5 against the same -$40 stop (8 units of buffer)")
    table([simulate(p, unit=5.0, max_bets=150) for p in RATES])

    hdr("E. Effect of price at a 55% win rate, $10 unit, -$40 stop, 150 games")
    print("  price   breakeven   P(hit -$40)   mean P/L")
    for price in (-150, -130, -110, +100, +120):
        r = simulate(0.55, price=price, max_bets=150)
        print(f"  {price:+5d}   {breakeven(price)*100:7.2f}%   "
              f"{r['p_stop_loss']*100:9.1f}%   {r['mean_pl']:+8.2f}")

    hdr("F. How many straight losses the stop loss allows")
    for unit in (5.0, 10.0, 20.0):
        print(f"  ${unit:.0f} unit -> {int(40 // unit)} consecutive losses "
              f"ends the session")

    # Parlays of +EV legs are themselves +EV -- that is not the problem.
    # The problem is hit rate against a 4-unit stop loss: a strategy that
    # only cashes 1 ticket in 6 goes broke long before the edge shows up.
    hdr("G. Parlays vs. the -$40 stop: EV is not the binding constraint, "
        "hit rate is")
    # standard book payouts for n-leg parlays of -110 legs
    BOOK = {1: 0.909, 2: 2.6, 3: 5.96, 4: 12.28, 5: 24.36}
    print("  legs  per-leg  hit rate  pays   EV/$10   P(hit -$40 in 150 tickets)")
    for legs in (1, 2, 3, 4, 5):
        for leg_p in (0.524, 0.550):
            hit = leg_p ** legs
            mult = BOOK[legs]
            ev = (hit * mult - (1 - hit)) * 10
            r = simulate(hit, max_bets=150, win_multiple=mult)
            print(f"  {legs:4d}  {leg_p*100:6.1f}%  {hit*100:7.1f}%  "
                  f"{mult:5.2f}u  {ev:+6.2f}   {r['p_stop_loss']*100:9.1f}%")


if __name__ == "__main__":
    main()
