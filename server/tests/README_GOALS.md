# Goal-driven test suite (`test_goal_*.py`)

This is the **executable form of `docs/END_GOALS.md`**. Each measurable end
goal becomes one or more tests so "done" is something CI checks, not something
we argue about.

## How it works

- A goal that is **already met** is a normal passing test.
- A goal that is **not yet implemented** is marked
  `@pytest.mark.xfail(reason="G#: ...", strict=False)`.
  - It runs, fails the way the goal says it should today, and is reported as
    **XFAIL** — so the suite stays green.
  - The day the feature lands, the test passes and is reported as **XPASS**.
    **An XPASS is the signal to delete the `xfail` marker** — the goal is done.

Track progress with:

```bash
pytest server/tests/test_goal_*.py -rX   # list everything still XFAIL (open goals)
pytest server/tests/test_goal_*.py -rA   # full report
```

When `pytest -rX` lists nothing, every goal in `END_GOALS.md` is met.

## Goal → test map

| Goal | File | Real / xfail today |
|---|---|---|
| **G1** Tests green, ≥80% coverage, data failure paths | `test_goal_correctness.py` | failure-path tests real; coverage-gate xfail |
| **G2** Docs match code (5 named drifts) | `test_goal_correctness.py` | code-constant tests real; doc-text tests xfail |
| **G3** No silent insecure defaults | `test_goal_security.py` | placeholder real; startup-warning xfail |
| **G4** Money conserved, atomic writes, export | `test_goal_portfolio.py` | conservation/avg-price real; atomicity & export xfail |
| **G5** Graceful when OHLC missing | `test_goal_correctness.py` | real |
| **G6** Resilient fetches + `/api/health` | `test_goal_api_contract.py` | xfail |
| **G7** Request validation → 422 not 500 | `test_goal_api_contract.py` | xfail |
| **G8** ML honest & durable + UI label | `test_goal_ml_cache.py`, `test_goal_frontend_deploy.py` | None-on-missing real; persistence/metric/label xfail |
| **G9** Caches survive cold start | `test_goal_ml_cache.py` | xfail |
| **G10** Self-service password change | `test_goal_api_contract.py` | xfail |
| **G11** One-command cross-platform run | `test_goal_frontend_deploy.py` | xfail |
| **G12** Configurable CORS (no `*`) | `test_goal_security.py` | xfail |
| **G13** GET `/api/portfolio` is read-only | `test_goal_portfolio.py` | xfail |
| **G14** Recommendation P&L uses `net_invested` | `test_goal_portfolio.py` | xfail |
| **G15** Mobile/accessibility | `test_goal_frontend_deploy.py` | viewport real; a11y xfail |
| **G16** Visible not-financial-advice disclaimer | `test_goal_frontend_deploy.py` | xfail |

The existing `test_*.py` files remain the functional regression suite; these
`test_goal_*.py` files are the forward-looking definition-of-done.
