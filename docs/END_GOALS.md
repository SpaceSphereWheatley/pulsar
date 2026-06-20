# PULSAR — Project End Goals (Definition of "Done")

> A measurable finishing line for PULSAR, written by walking the whole project from
> two points of view and making them argue until they agreed:
>
> - **The Senior Programmer** — cares about correctness, security, reliability, and
>   whether the next person can run, trust, and maintain this code.
> - **The Critical End User** — runs it at home, has limited patience, doesn't read
>   source code, and wants numbers they can trust and a portfolio they won't lose.
>
> Every goal below has a **measurable acceptance criterion** — a number or a yes/no
> you can check — so "done" is a fact, not an opinion. Nothing here is aspirational
> polish; it is the set of things that currently stand between PULSAR and being
> genuinely finished.

---

## How to read this

- Each goal is `[ ]` (open) or `[x]` (met today).
- **Measure** = the exact, checkable condition that closes the goal.
- Goals are grouped and ordered by priority. **P0** = blocks "finished." **P1** =
  required for a credible 1.0. **P2** = the agreed-upon finish line for polish.
- The **Non-Goals** section is part of the contract: it bounds the project so
  "done" stays reachable.

### Where the project stands today (baseline, measured)

| Signal | Measured value |
|---|---|
| Tests passing | **167 / 167** (`pytest`) |
| Lint | **`ruff check server/` clean** |
| Test coverage gate | CI enforces **≥ 70%** |
| Backend modules | 12 (`server/*.py`), ~1,900 LOC |
| Frontend | single-file SPA, ~1,190 LOC |
| Open functional bugs found in review | see G2, G14 (doc drift + 1 stale fallback) |

The codebase is in good shape. The gap to "finished" is **not** rescue work — it
is hardening, truth-in-documentation, and a handful of user-trust features.

---

## P0 — Blocks "finished"

These are the items where the Senior Programmer and the End User agreed loudest.

### G1 — The test suite is green and meaningfully covers the code
- **Why (both):** Programmer needs a safety net; User needs to trust the math.
- **Measure:**
  - `pytest` exits 0 with **0 failures and 0 errors** on a clean `pip install -r requirements.txt -r requirements-dev.txt`.
  - Coverage **≥ 80%** overall (raise CI's `--cov-fail-under` from 70 → 80).
  - `data.py` refresh/fetch paths have at least **one test each** for the failure branch (API throws → cache untouched, no crash).
- **Status:** `[x]` CI gate raised to 80% (actual coverage ~92%); `data.py` refresh/fetch failure branches are tested.

### G2 — Documentation matches the code (zero drift)
- **Why (Programmer):** Drifted docs are worse than none — they actively mislead.
- **Measure:** every concrete claim in `README.md`, `docs/pulsardocs.md`, and
  `CLAUDE.md` is true against `HEAD`. Specifically these known-drifted facts are corrected:
  1. OHLC window is **14 days**, not 90 (`docs/pulsardocs.md` §4, §5, §6).
  2. Indicators are **hand-rolled in `indicators.py`**, not `pandas-ta` (§3, §6, requirements).
  3. Portfolio starts at **$0 with deposit/withdraw**, not $10,000 `initial_cash` (§8).
  4. `README.md` "Build phases" table reflects reality: **Phases 1–5 shipped** (or the table is removed).
  5. The `/api/portfolio` and `/api/feargreed` example payloads match the actual response keys (e.g. `total_deposited`/`net_invested`, NOK fields, `market_score`).
- **Done when:** a reader can follow any doc statement and observe exactly that behavior. **0 contradictions.**
- **Status:** `[x]` all 5 named drifts corrected; example payloads match real responses.

### G3 — No insecure defaults can reach a running instance unnoticed
- **Why (both):** User may expose the port; Programmer knows `admin/admin` + a
  hard-coded dev secret is a foot-gun.
- **Measure:**
  - On startup, if `PULSAR_SECRET_KEY` is still the bundled dev default **or**
    `PULSAR_ADMIN_PASSWORD` is `admin`, the server logs a **prominent WARNING** (and the
    `/` page shows a dismissible banner). Verified by a test asserting the warning fires.
  - A documented one-command path to generate a real secret (`openssl rand -hex 32`) exists in `.env.example` (already present) **and** README setup.
- **Status:** `[x]` `auth.warn_insecure_defaults()` fires a WARNING on startup; tested.

### G4 — Portfolio data cannot be corrupted or lost by normal use
- **Why (User):** "My portfolio is the one thing I actually care about."
- **Measure:**
  - Portfolio/watchlist/history JSON writes are **atomic** (write-temp-then-rename), proven by a test that interrupts/!concurrently writes and never yields a truncated/invalid file.
  - Buy/sell math is exact to the cent: a property test of N random buy/sell sequences asserts `cash + Σ(holding_value_at_cost) == Σ(deposits) − Σ(withdrawals) − realized_loss` invariants hold (no money created or destroyed).
  - A user can **export** their portfolio + transaction history to CSV/JSON from the UI (one click) → addresses "don't lose my data on a container reset."
- **Status:** `[x]` writes go via temp-file + `os.replace`; `GET /api/portfolio/export` returns CSV (or JSON).

---

## P1 — Required for a credible 1.0

### G5 — Graceful behavior when CoinGecko data is missing
- **Why (User):** Without an API key, OHLC/signals/ML/backtest are silently empty
  and the app looks broken.
- **Measure:**
  - With **no** `COINGECKO_API_KEY`, the UI shows an explicit, friendly state
    ("History/Signals need a free CoinGecko key — here's how") instead of blank cards.
  - `/api/coins`, `/api/signals`, `/api/backtest/*` return a structured, documented
    response (not a 500) when OHLC is absent. Asserted by tests with OHLC cache empty.
- **Status:** `[ ]`

### G6 — External API failures are resilient, not fatal
- **Why (Programmer):** Free APIs rate-limit and flake.
- **Measure:**
  - All outbound fetches (coins, OHLC, F&G, news, NOK) use **timeout + bounded retry
    with backoff**; a forced failure in tests leaves the last-good cache served and logs once.
  - A `GET /api/health` endpoint reports per-cache freshness (age in seconds) and
    overall `ok|degraded`. Covered by a test.
- **Status:** `[ ]` try/except exists; no retry, no health endpoint.

### G7 — Request bodies are validated, not trusted
- **Why (Programmer):** `body: dict` + `float(body.get(...))` invites 500s on bad input.
- **Measure:** every POST route (`login`, `buy`, `sell`, `deposit`, `withdraw`,
  user/portfolio create) uses a **Pydantic model**; malformed input returns a
  **422 with a clear message**, never a 500. One negative test per route.
- **Status:** `[ ]`

### G8 — The ML score is honest and durable
- **Why (both):** User must not mistake it for a forecast; Programmer wants it to
  survive a restart and be evaluable.
- **Measure:**
  - ML scores **persist** (to disk) so a restart doesn't blank `/api/signals` for 6h.
  - `/api/signals` (or a new field) exposes a **backtested quality metric** per coin
    (e.g. directional hit-rate on held-out data) so the score is auditable.
  - UI labels the ML score **"experimental"** wherever shown. Verified in `index.html`.
- **Status:** `[ ]` scores are in-memory only; no exposed quality metric.

### G9 — Caches survive a cold start
- **Why (Programmer):** A restart currently re-hammers CoinGecko and shows 503s until warm.
- **Measure:** OHLC/coins/F&G/news caches persist to `server/cache.json` (already
  gitignored) and are loaded on boot; first request after restart serves cached data
  with no external call. Asserted by a boot-without-network test.
- **Status:** `[ ]`

### G10 — A non-admin user can manage their own account
- **Why (User):** "I was given a login; I want to change my password."
- **Measure:** authenticated `POST /api/auth/password` (self) exists, hashes with
  bcrypt, and the UI exposes it. Test: change password → old fails, new succeeds.
- **Status:** `[ ]`

---

## P2 — The agreed finish line for polish & shipping

### G11 — One-command, cross-platform run
- **Why (both):** `start.sh` is macOS-only (`caffeinate`); setup should be trivial.
- **Measure:** a **Dockerfile** (or documented `make run`) brings the app up on
  Linux/macOS/Windows with `.env` mounted; README's quick-start works verbatim,
  verified on a clean checkout.
- **Status:** `[ ]`

### G12 — Tightened, documented CORS
- **Why (Programmer):** `allow_origins=["*"]` with credentials-bearing tokens is sloppy
  even for localhost.
- **Measure:** allowed origins come from an env var (default `http://localhost:8000`,
  `http://localhost:8001`); `*` is no longer hard-coded. README documents how to add one.
- **Status:** `[ ]`

### G13 — Snapshotting has no side effects on reads
- **Why (Programmer):** `_portfolio_response` writes a history snapshot on every
  `GET /api/portfolio`, mutating state during a read.
- **Measure:** daily snapshotting moves to the scheduler (or a dedicated call);
  `GET /api/portfolio` is provably read-only (test asserts no file write on GET).
- **Status:** `[ ]`

### G14 — P&L summary uses the live capital model everywhere
- **Why (Programmer):** `recommendation.py` still computes `total_pnl_pct` from a
  legacy `initial_cash` (default 10,000) while the rest of the app uses
  `total_deposited − total_withdrawn`. On a $0-start portfolio these disagree.
- **Measure:** recommendation summary derives P&L from `net_invested`, matching
  `_portfolio_response`. A test with deposits ≠ 10,000 asserts the two agree.
- **Status:** `[x]` summary P&L now derives from `net_invested`.

### G15 — Accessibility & mobile pass
- **Why (User):** It's a mobile-first app; it should be usable on a phone and with a screen reader.
- **Measure:** Lighthouse (or axe) **Accessibility ≥ 90** on the served page;
  interactive controls have labels; the layout has no horizontal scroll at 375px width.
- **Status:** `[ ]`

### G16 — User-facing disclaimer is unmissable
- **Why (both):** "Not financial advice" must be visible, not buried in docs.
- **Measure:** the dashboard shows a persistent (or first-run) disclaimer that
  signals/scores/ML are educational and not advice. Present in `index.html`.
- **Status:** `[ ]`

---

## The Finish Line (single checklist)

PULSAR is **done** when every box below is checked:

- [x] **G1** Tests: 0 failures/errors, coverage ≥ 80%, `data.py` failure paths tested
- [x] **G2** Docs: 0 contradictions with `HEAD` (5 named drifts fixed)
- [x] **G3** Insecure defaults warn loudly at startup (tested)
- [x] **G4** Atomic writes + money-conservation invariant test + UI export
- [ ] **G5** Friendly empty-state + no 500s when OHLC absent (tested)
- [ ] **G6** Retry/backoff on all fetches + `/api/health` (tested)
- [ ] **G7** Pydantic validation on every POST → 422 not 500 (tested)
- [ ] **G8** ML scores persist, expose a quality metric, labeled experimental
- [ ] **G9** Caches persist and load on boot (no-network boot test)
- [ ] **G10** Self-service password change (tested)
- [ ] **G11** One-command cross-platform run (Docker/make)
- [ ] **G12** CORS from env, no hard-coded `*`
- [ ] **G13** `GET /api/portfolio` is read-only (tested)
- [x] **G14** Recommendation P&L uses `net_invested` (tested)
- [ ] **G15** Accessibility ≥ 90, no 375px horizontal scroll
- [ ] **G16** Persistent not-financial-advice disclaimer in UI

**Release gate:** all **P0 + P1** checked → tag **`v1.0`**. All **P2** checked →
tag **`v1.1` "finished."**

---

## Non-Goals (explicitly out of scope — protects the finish line)

These were raised in the two-POV walkthrough and **deliberately excluded** so "done"
stays reachable. Adding any of them reopens the contract.

- **No database.** Persistence stays JSON-on-disk (per `CLAUDE.md`).
- **No real trading / real money / exchange integration.** Portfolio stays virtual.
- **No more than the top-10 coins.** Scope is fixed at `TOP_N = 10`.
- **No multi-tenant scaling / horizontal deployment.** This is a locally-hosted,
  single-instance app; concurrency hardening (G4) is for one user's own clients, not a SaaS.
- **No LSTM / deep-learning model.** ML stays the interpretable Ridge regression;
  the goal (G8) is honesty and durability, not predictive accuracy.
- **No build step / framework for the frontend.** It remains a single vanilla-JS file.
- **No promise of profitable signals.** Success is *measurable, trustworthy, and
  clearly-disclaimed* output — never investment performance.
