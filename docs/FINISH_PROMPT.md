# Finish PULSAR — Claude Code prompt

Copy everything in the fenced block below into a fresh Claude Code session
**from the repo root**, on a working branch. It uses the goal-driven test suite
(`server/tests/test_goal_*.py`) as the executable definition-of-done: the job is
to drive every `xfail` to a real pass until `pytest -rX` reports nothing.

The prompt is **self-looping** — once pasted it works goal-by-goal without
stopping for confirmation until the done-condition holds. To instead run it on a
scheduled interval (e.g. babysitting a long build), paste this one-liner instead:

```text
/loop 20m Continue finishing PULSAR per docs/FINISH_PROMPT.md: pick the next xfail
goal, implement it, remove the marker, keep pytest + ruff green, commit and push.
Stop the loop when `pytest -rX server/tests/test_goal_*.py` reports zero xfails.
```

---

````text
You are finishing the PULSAR project. The finished state is already defined for
you as an executable spec — your job is to make it true, one goal at a time.

## Source of truth (read these first, in order)
1. `CLAUDE.md` — architecture, conventions, hard constraints. Obey it.
2. `docs/END_GOALS.md` — the 16 measurable end goals (G1–G16), grouped P0/P1/P2.
3. `server/tests/README_GOALS.md` — how the goal suite encodes those goals.
4. `server/tests/test_goal_*.py` — the goals AS TESTS. These are your spec.

## The mission
Every goal that is not yet met is a test marked
`@pytest.mark.xfail(reason="G#: ...")`. Implement the real feature so the test
passes, then DELETE that xfail marker. The project is finished when:

- `pytest -rX server/tests/test_goal_*.py` lists ZERO xfails remaining.
- `pytest` (the whole suite) is green: 0 failures, 0 errors, 0 xfails, 0 xpasses.
- `ruff check server/` and `ruff format --check server/` both pass.
- CI's coverage gate is met (you will raise it to 80% as part of G1).
- `docs/END_GOALS.md` checkboxes are all `[x]` and match reality.

## Hard rules (do not violate)
- NO database. Persistence stays JSON-on-disk (see CLAUDE.md). 
- NO new heavy dependencies without strong justification; prefer the stdlib.
  Pydantic and python-dateutil-level additions are fine; ML/infra frameworks are not.
- Keep the frontend a single vanilla-JS file (`frontend/index.html`), no build step.
- Ruff line length is 100. Match the surrounding code style.
- Do NOT weaken or delete a goal test to make it pass. If a test's contract is
  genuinely wrong, fix the test AND update `docs/END_GOALS.md` in the same commit
  and explain why in the commit message. Tests are the spec; changing the spec is
  a deliberate, documented act, not a shortcut.
- Never call CoinGecko/alternative.me inline from a route handler (caches only).

## Workflow — repeat this loop until done
Work goals in priority order: all P0, then P1, then P2 (order listed below).
For EACH goal:
1. Run its test(s) and read the xfail `reason` — it names the exact contract.
2. Implement the real feature in `server/` (and `frontend/index.html` where the
   goal is UI). Honor the symbol/endpoint names the test expects.
3. Remove the `@pytest.mark.xfail(...)` marker for that goal's test(s).
4. Run `pytest` (full suite) + `ruff check server/` + `ruff format server/`.
   Everything must be green before you move on.
5. Tick the goal's boxes in `docs/END_GOALS.md`.
6. Commit with a focused message: `Gn: <what changed>`. Then push.
Never batch multiple goals into one commit. One goal = one green, reviewable commit.

## Autonomous loop — do not stop to ask
Run this as a continuous loop. After each goal's green commit, IMMEDIATELY pick the
next xfail goal and keep going — do not pause for confirmation. At the top of every
cycle, re-run the full done-check (`pytest`, `pytest -rX server/tests/test_goal_*.py`,
`ruff check`/`ruff format --check`). If you hit an ambiguous decision you cannot
resolve from `CLAUDE.md`, `docs/END_GOALS.md`, or the test contract, make the most
reasonable choice consistent with those documents, record it in the commit message,
and continue — do NOT halt. Only stop when the done-condition below is fully met, or
when a test exposes a genuine conflict in the spec itself (then fix test + END_GOALS
together, per the hard rules, and continue). Report progress as you close each goal;
do not wait until the end.

## The goals and the exact contract each test expects

P0:
- G1 — Quality floor. The data-layer failure tests already pass; KEEP them green.
  Raise CI coverage gate in `.github/workflows/ci.yml` to `--cov-fail-under=80`
  and add tests until real coverage clears 80%. (Closes `test_coverage_gate_*`.)
- G2 — Docs match code. Fix the 4 drifted prose claims so these flip to pass:
  `docs/pulsardocs.md` 90-day→14-day, remove `pandas-ta` references, portfolio
  starts at $0 (not $10k `initial_cash`); `README.md` build-phase table no longer
  says "Pending". Make example payloads match real responses.
- G3 — Secure defaults. Add `warn_insecure_defaults()` (in `main` or `auth`),
  called on startup, that logs a prominent WARNING when `PULSAR_SECRET_KEY` is the
  bundled dev default or `PULSAR_ADMIN_PASSWORD == "admin"`. Test expects the
  symbol to exist and the warning to fire.
- G4 — Portfolio integrity. Make `portfolio.save_portfolio` (and the other JSON
  writers) atomic via temp-file + `os.replace`. Add `GET /api/portfolio/export`
  returning the portfolio + transactions (CSV or JSON). Keep the money-conservation
  and avg-price tests green.

P1:
- G5 — Already met (graceful empty-OHLC). Keep green.
- G6 — Add `GET /api/health` returning `{"status": "ok"|"degraded", "caches": {...}}`
  with per-cache age in seconds. Add bounded retry+backoff (the word "retry" or
  "backoff" must appear in `data.py`) around outbound fetches.
- G7 — Replace raw-`dict` request bodies with Pydantic models on every POST
  (`login`, `buy`, `sell`, `deposit`, `withdraw`, user/portfolio create) so
  malformed input returns 422, never 500.
- G8 — Persist ML scores to disk: add `ml.save_scores()` + `ml.load_scores()` and
  load on startup. Expose an auditable quality metric per coin in `/api/signals`
  (e.g. key `ml_quality` or `ml_hit_rate`). Label the ML score "experimental" in
  `frontend/index.html`.
- G9 — Add `data.save_caches()` + `data.load_caches()` (to `server/cache.json`,
  already gitignored); load on boot so a cold start serves cache with no network.
- G10 — Add `POST /api/auth/password` (authenticated self-service) that verifies
  the current password and sets a new bcrypt hash; expose it in the UI.

P2:
- G11 — Add a `Dockerfile` (or `Makefile` with a `run` target) for one-command,
  cross-platform startup; make the README quick-start work verbatim.
- G12 — Drive CORS `allow_origins` from a new env var `PULSAR_CORS_ORIGINS`
  (comma-separated), defaulting to `http://localhost:8000,http://localhost:8001`
  (the uvicorn-dev and start.sh ports). Remove the hard-coded `["*"]` from
  `server/main.py`. Document the var in `.env.example` and `CLAUDE.md`.
- G13 — Make `GET /api/portfolio` read-only: move the daily history snapshot out of
  `_portfolio_response` into the scheduler (or a dedicated write path). The test
  asserts a GET creates no history file.
- G14 — In `recommendation.py`, compute the summary P&L from
  `net_invested = total_deposited - total_withdrawn` (matching `_portfolio_response`),
  not the legacy `initial_cash=10000` fallback.
- G15 — Wire **Lighthouse CI** into `.github/workflows/ci.yml` (e.g. the
  `treosh/lighthouse-ci-action`) as a new job that starts the server, audits the
  served page, and **fails the build if the Accessibility category is below 0.90**.
  Add an `lighthouserc`/config asserting `categories:accessibility` minScore 0.9.
  Keep the existing viewport/button-label tests green.
- G16 — Add a persistent "not financial advice / educational only" disclaimer to
  `frontend/index.html`.

## When you finish
Run the full suite one last time, confirm `pytest -rX server/tests/test_goal_*.py`
is empty, confirm ruff is clean, and post a short summary: which goals you closed,
the final test counts, and the new coverage percentage. Do not open a pull request
unless I ask.

Start now with G2 and G14 (fastest wins), then proceed in P0→P1→P2 order.
````

---

## Notes for you (not part of the prompt)

- **Why this works:** the prompt doesn't describe features in prose that can drift —
  it points at tests that already encode acceptance. "Done" is `pytest -rX` being
  empty, which is unambiguous and self-checking.
- **Hands-off:** the prompt is self-looping (the "Autonomous loop" section). For a
  scheduled cadence instead, use the `/loop 20m …` one-liner at the top of this file.
- **Scope guard:** the prompt forbids weakening tests and pins the no-database /
  single-file-frontend / line-length-100 constraints so the agent can't "finish" by
  cutting corners.
- **Decisions already made for you** (baked into the prompt, change only if you want):
  - G12 CORS → `PULSAR_CORS_ORIGINS`, default `http://localhost:8000,http://localhost:8001`.
  - G15 audit → Lighthouse CI, Accessibility category gated at ≥ 0.90.
