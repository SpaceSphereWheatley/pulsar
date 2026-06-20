"""Phase 0 — capture Python ground-truth output for the JS port to verify against.

Runs the *current* pandas/scikit-learn implementation over a spread of OHLC
datasets (sparse / exactly-min / flat / trending / volatile / the real test
fixture) and dumps, for each:

  * the raw OHLC input (so the JS test feeds the identical bytes),
  * the full RSI / MACD / Bollinger series (not just the last value) for
    deep series-level parity,
  * the public compute_indicators() output (the app's actual contract),
  * compute_signal() output across a few change_7d values,
  * the ML _build_dataset() shape + refresh_ml_scores() score/quality.

Output: migration/fixtures/indicators.json and migration/fixtures/ml.json

Run from the repo root:  python3 migration/generate_fixtures.py
These fixtures are committed and become the assertions for worker/tests.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Import the real implementation modules.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import backtest  # noqa: E402
import indicators  # noqa: E402
import ml  # noqa: E402

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


# ── Deterministic OHLC builders ───────────────────────────────────────────────
# Each candle is [ts_ms, open, high, low, close]. Only close drives the math,
# but we fill plausible OHLC. ts descends like the real CoinGecko fixture so the
# JS port must replicate the sort-by-ts step too.


def _candles(closes_oldest_first: list[float]) -> list[list[float]]:
    """Emit newest-first candles (i=0 newest, like CoinGecko / conftest MOCK_OHLC)
    from a chronological (oldest-first) close list, so dataset *labels* describe the
    series as it reads after the time-sort the indicators apply."""
    base_ts = 1_715_000_000_000
    out = []
    n = len(closes_oldest_first)
    for i, c in enumerate(reversed(closes_oldest_first)):
        # i=0 is the newest candle → largest ts.
        ts = base_ts - i * 86_400_000
        o = c * 0.998
        hi = max(o, c) * 1.01
        lo = min(o, c) * 0.99
        out.append([ts, round(o, 4), round(hi, 4), round(lo, 4), round(c, 4)])
    assert len(out) == n
    return out


def _mock_ohlc_90() -> list[list[float]]:
    # Exact replica of server/tests/conftest.py MOCK_OHLC.
    return [
        [
            1_715_000_000_000 - i * 86_400_000,
            65_000.0 + (i % 5) * 200,
            67_000.0 + (i % 5) * 200 + 500,
            63_000.0 + (i % 5) * 200 - 500,
            65_000.0 + (i % 7 - 3) * 300,
        ]
        for i in range(90)
    ]


def _build_datasets() -> dict[str, list[list[float]]]:
    rng = np.random.default_rng(20240517)
    datasets: dict[str, list[list[float]]] = {}

    # Real test fixture (90 cyclic candles).
    datasets["mock_ohlc_90"] = _mock_ohlc_90()

    # Sparse: 25 candles → compute_indicators() returns None (<30).
    datasets["sparse_25"] = _candles([100 + i for i in range(25)])

    # Exactly 30 candles: indicators valid, but <40 so ML returns None.
    datasets["min_indicators_30"] = _candles(
        [100 + 5 * math.sin(i / 3) for i in range(30)]
    )

    # Exactly 40 candles: the ML minimum boundary.
    datasets["min_ml_40"] = _candles(
        [200 + 10 * math.sin(i / 4) + 0.3 * i for i in range(40)]
    )

    # Flat prices, 45 candles: zero rolling std (BB band_range == 0) and zero
    # losses (RSI avg_loss == 0 → RS == inf). Exercises the NaN/Inf guards.
    datasets["flat_45"] = _candles([500.0 for _ in range(45)])

    # Steady uptrend, 60 candles.
    datasets["trend_up_60"] = _candles([1000 + 8 * i for i in range(60)])

    # Steady downtrend, 60 candles.
    datasets["trend_down_60"] = _candles([2000 - 9 * i for i in range(60)])

    # Volatile random walk, 80 candles.
    walk = [3000.0]
    for _ in range(79):
        walk.append(max(1.0, walk[-1] * (1 + rng.normal(0, 0.04))))
    datasets["volatile_80"] = _candles([round(x, 4) for x in walk])

    return datasets


# ── Full-series recomputation (mirrors indicators.py internals) ───────────────
# indicators.py only exposes the last value; for series-level parity we recompute
# the whole series with the identical pandas calls used inside that module.


def _safe_list(series: pd.Series) -> list:
    out = []
    for v in series.tolist():
        if v is None:
            out.append(None)
            continue
        try:
            f = float(v)
            out.append(None if math.isnan(f) or math.isinf(f) else f)
        except (TypeError, ValueError):
            out.append(None)
    return out


def _full_series(ohlc: list) -> dict | None:
    if not ohlc or len(ohlc) < 30:
        return None
    df = pd.DataFrame(ohlc, columns=["ts", "open", "high", "low", "close"])
    df = df.sort_values("ts").reset_index(drop=True)
    close = df["close"].astype(float)

    # RSI-14 (Wilder, com=13, min_periods=14) — identical to indicators._rsi.
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=13, adjust=False, min_periods=14).mean()
    avg_loss = loss.ewm(com=13, adjust=False, min_periods=14).mean()
    rs = avg_gain / avg_loss
    rsi = 100.0 - 100.0 / (1.0 + rs)

    # MACD(12,26,9) — identical to indicators._macd.
    ema_fast = close.ewm(span=12, adjust=False).mean()
    ema_slow = close.ewm(span=26, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    histogram = macd_line - signal_line

    # Bollinger(20, 2σ, ddof=1) — identical to indicators._bbands.
    sma = close.rolling(20).mean()
    std = close.rolling(20).std(ddof=1)
    upper = sma + 2.0 * std
    lower = sma - 2.0 * std

    return {
        "close_sorted": _safe_list(close),
        "rsi": _safe_list(rsi),
        "macd": _safe_list(macd_line),
        "macd_signal": _safe_list(signal_line),
        "macd_histogram": _safe_list(histogram),
        "bb_upper": _safe_list(upper),
        "bb_lower": _safe_list(lower),
    }


# ── ML dataset capture (mirrors ml._build_dataset / refresh_ml_scores) ────────


def _ml_capture(coin_id: str, ohlc: list) -> dict:
    result = ml._build_dataset(ohlc)
    if result is None:
        return {"buildable": False, "score": None, "quality": None}

    X, y, x_pred = result
    cache = {coin_id: {"data": ohlc, "ts": 0}}
    ml.refresh_ml_scores(cache)

    return {
        "buildable": True,
        "n_train": int(X.shape[0]),
        "n_features": int(X.shape[1]),
        "X": X.tolist(),
        "y": y.tolist(),
        "x_pred": x_pred.tolist(),
        "score": ml.get_ml_score(coin_id),
        "quality": ml.get_ml_quality(coin_id),
    }


def main() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    datasets = _build_datasets()

    change_7d_values = [-15.0, -5.0, 0.0, 5.0, 15.0]

    indicators_out = {}
    ml_out = {}
    backtest_out = {}

    for name, ohlc in datasets.items():
        public = indicators.compute_indicators(ohlc)
        signals = {
            f"{c:+g}": indicators.compute_signal(public, c) for c in change_7d_values
        }
        indicators_out[name] = {
            "ohlc": ohlc,
            "n_candles": len(ohlc),
            "indicators": public,  # last-value public contract (may be None)
            "series": _full_series(ohlc),  # full series for deep parity
            "signals": signals,
        }
        ml_out[name] = _ml_capture(name, ohlc)
        # Backtest needs the inputs too so the JS test is self-contained.
        backtest_out[name] = {"ohlc": ohlc, "result": backtest.run_backtest(ohlc)}

    (FIXTURE_DIR / "indicators.json").write_text(
        json.dumps(indicators_out, indent=2, allow_nan=False)
    )
    (FIXTURE_DIR / "ml.json").write_text(
        json.dumps(ml_out, indent=2, allow_nan=False)
    )
    (FIXTURE_DIR / "backtest.json").write_text(
        json.dumps(backtest_out, indent=2, allow_nan=False)
    )

    print(f"Wrote {len(datasets)} datasets to {FIXTURE_DIR}/")
    for name in datasets:
        ind = indicators_out[name]["indicators"]
        mlf = ml_out[name]
        rsi = ind["rsi"] if ind else None
        print(
            f"  {name:20s} candles={indicators_out[name]['n_candles']:3d} "
            f"rsi={rsi!s:>8.8} ml_score={mlf['score']!s:>6} "
            f"ml_quality={mlf['quality']!s:>6}"
        )


if __name__ == "__main__":
    main()
