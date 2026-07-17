# TODO

Nothing outstanding right now.

`wrangler.toml` no longer defines any `[triggers] crons` — the Cloudflare
deployment's cron trigger budget concern is moot. Every cache in
`worker/index.js` (coins, OHLC+ML, Fear & Greed + USD→NOK, news, daily
portfolio snapshots) now refreshes on demand: fresh data is served as-is,
stale data is served immediately while a background refresh runs via
`ctx.waitUntil`, and missing data is fetched inline the first time a request
needs it. See `ensureCoinsFresh`/`ensureOhlcFresh`/`maybeRefreshNok` in
`worker/index.js`.
