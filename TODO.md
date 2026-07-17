# TODO

## Cron trigger budget: max 2

The app's Cloudflare deployment is capped at **2 cron triggers**. `wrangler.toml`
currently defines 5 (`crons = [...]` — coins/OHLC+ML/feargreed+NOK/news/portfolio
snapshots), which is over budget and needs to be redesigned to fit within 2.

- [ ] Consolidate the 5 scheduled refreshes (coins, OHLC+ML retrain, Fear & Greed
      + USD→NOK, news, daily portfolio snapshots) down to **2 cron triggers total**.
      Likely approach: one high-frequency trigger (e.g. every 5 min) that fans out
      to whichever refreshes are due based on elapsed time since last run (stored in
      D1 or KV), plus one low-frequency trigger (e.g. daily) for the portfolio
      snapshot job — or fold snapshotting into the frequent trigger too and drop to
      a single cron if possible.
  - Alternative: move less time-sensitive refreshes (news, NOK rate) to lazy
    on-demand refresh triggered by request + staleness check, instead of cron.
- [ ] Update `wrangler.toml`'s `[triggers] crons` list to match the redesigned
      schedule once implemented.
