"""ML scoring — Ridge regression on per-coin OHLC history."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

_ml_scores: dict[str, float] = {}
# Auditable quality metric per coin: in-sample directional hit-rate (0–100), i.e.
# how often the model's predicted return sign matched the realized forward return.
_ml_quality: dict[str, float] = {}

_SCORES_FILE = Path(__file__).parent / "ml_scores.json"


def get_ml_score(coin_id: str) -> Optional[float]:
    return _ml_scores.get(coin_id)


def get_ml_quality(coin_id: str) -> Optional[float]:
    """Directional hit-rate (0–100) for the coin's model, or None if untrained."""
    return _ml_quality.get(coin_id)


def save_scores() -> None:
    """Persist ML scores + quality so a restart doesn't blank /api/signals for 6h."""
    payload = {"scores": _ml_scores, "quality": _ml_quality}
    fd, tmp = tempfile.mkstemp(dir=str(_SCORES_FILE.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(payload))
        os.replace(tmp, _SCORES_FILE)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_scores() -> None:
    """Load persisted ML scores + quality from disk (no-op if the file is absent)."""
    global _ml_scores, _ml_quality
    if not _SCORES_FILE.exists():
        return
    try:
        payload = json.loads(_SCORES_FILE.read_text())
        _ml_scores = payload.get("scores", {})
        _ml_quality = payload.get("quality", {})
        logger.info("Loaded %d persisted ML scores", len(_ml_scores))
    except Exception as exc:
        logger.warning("Could not load persisted ML scores: %s", exc)


def _build_dataset(
    ohlc: list,
) -> Optional[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Return (X_train, y_train, x_latest) or None if data is insufficient."""
    if len(ohlc) < 40:
        return None

    df = pd.DataFrame(ohlc, columns=["ts", "open", "high", "low", "close"])
    df = df.sort_values("ts").reset_index(drop=True)
    close = df["close"]

    # RSI-14 (Wilder's smoothing via EWM with com=13)
    delta = close.diff()
    avg_gain = delta.clip(lower=0).ewm(com=13, adjust=False).mean()
    avg_loss = (-delta.clip(upper=0)).ewm(com=13, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)

    # MACD histogram (12, 26, 9)
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    macd_hist = macd_line - signal_line

    # Bollinger Band position (20, 2σ): 0 = lower band, 1 = upper band
    bb_mid = close.rolling(20).mean()
    bb_std = close.rolling(20).std(ddof=1)
    band_width = (4 * bb_std).replace(0, np.nan)
    bb_pos = (close - (bb_mid - 2 * bb_std)) / band_width

    # 7-day lookback return (%)
    ret7 = close.pct_change(7) * 100

    # Target: forward 7-day return (%)
    fwd7 = (close.shift(-7) / close - 1) * 100

    feat = pd.DataFrame({"rsi": rsi, "macd_hist": macd_hist, "bb_pos": bb_pos, "ret7": ret7})

    # Training rows need all features valid and a target available
    valid = feat.notna().all(axis=1) & fwd7.notna()
    # Exclude the last 7 rows (no forward target yet)
    train_mask = valid & (feat.index < len(df) - 7)

    if train_mask.sum() < 10:
        return None

    X = feat.loc[train_mask].values.astype(float)
    y = fwd7.loc[train_mask].values.astype(float)

    # Use the most recent row that has all features for prediction
    pred_idx = feat.dropna().index[-1]
    x_pred = feat.loc[pred_idx].values.astype(float).reshape(1, -1)

    return X, y, x_pred


def refresh_ml_scores(ohlc_cache: dict) -> None:
    """Train a Ridge model per coin and populate _ml_scores + _ml_quality."""
    global _ml_scores, _ml_quality
    new_scores: dict[str, float] = {}
    new_quality: dict[str, float] = {}

    for coin_id, entry in ohlc_cache.items():
        ohlc = entry.get("data") if isinstance(entry, dict) else entry
        if not ohlc:
            continue

        result = _build_dataset(ohlc)
        if result is None:
            continue

        X, y, x_pred = result
        try:
            scaler = StandardScaler()
            X_s = scaler.fit_transform(X)
            x_s = scaler.transform(x_pred)

            model = Ridge(alpha=1.0)
            model.fit(X_s, y)
            pred = float(model.predict(x_s)[0])

            # Map predicted return to 0-100 via percentile rank vs training targets
            score = round(float(np.mean(y < pred)) * 100, 1)
            new_scores[coin_id] = max(0.0, min(100.0, score))

            # Auditable quality: in-sample directional hit-rate (% of rows where
            # the predicted return sign matched the realized forward return).
            y_pred = model.predict(X_s)
            hit_rate = float(np.mean(np.sign(y_pred) == np.sign(y))) * 100
            new_quality[coin_id] = round(hit_rate, 1)
        except Exception:
            pass

    _ml_scores = new_scores
    _ml_quality = new_quality
    try:
        save_scores()
    except Exception as exc:
        logger.warning("Could not persist ML scores: %s", exc)
