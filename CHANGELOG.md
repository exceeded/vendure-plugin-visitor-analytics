# Changelog

All notable changes to `@huloglobal/vendure-plugin-visitor-analytics` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this
project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added
- **Conversion goals** — new `ConversionGoal` entity with a URL-glob
  matcher (`*` within segment, `**` across segments). Pageviews matching
  a goal are tagged with `goalId` at ingest. CRUD endpoints
  (`GET /ees/goals`, `POST /ees/goals`, `PUT /ees/goals/:id`,
  `DELETE /ees/goals/:id`) and `GET /ees/goals/stats` for completion
  totals per period.
- **Bot detection** — UA-classified `isBot` boolean on every event.
  Default keeps bot events for visibility; new `dropBotEvents` option
  skips ingest entirely.
- **Privacy controls** —
  - `honorDoNotTrack` (default `true`) — `DNT: 1` returns
    `{stored:0, skipped:'dnt'}`
  - `anonymizeIp` (default `true`) — IPv4 last octet / IPv6 last 80 bits
    dropped before storage; `ipHash` still uses the raw IP
  - `requireConsent` (default `false`) — gate ingest behind a body
    `consent:true` or cookie `ees_consent=1`
- **CSV export** — `GET /ees/visitors/export.csv?days=N` (max 90).

## [0.2.0]

### Added
- **UTM attribution** — `utmSource` / `utmMedium` / `utmCampaign` /
  `utmTerm` / `utmContent` and `referrerDomain` columns parsed from every
  incoming pageview URL. New `GET /ees/visitors/sources` admin endpoint
  groups visitors by `(source, medium)` plus per-source conversion
  counts (reached product page, reached cart/checkout).
- **Live-now widget** — Server-Sent Events stream at
  `GET /ees/visitors/live` pushing the active-visitor count and the
  20 most recent URLs every 5 seconds. SSE clients auto-reconnect.
- **Top events** admin endpoint at `GET /ees/visitors/top-events`,
  paginated.
- **Custom event recipes** — README section with copy-paste storefront
  snippets for add-to-cart, search, quote-request, newsletter signup.

## [0.1.0] — Unreleased

### Added
- `VisitorAnalyticsPlugin` — ingest endpoint + admin dashboards.
- `VisitorEvent` entity capturing pageview / unload / event rows with
  full UA parse, MaxMind geo enrichment, raw + hashed IP.
- Proxy-aware IP / country / region extraction (Cloudflare, Akamai,
  Fastly headers all detected; falls back to MaxMind only if the
  upstream didn't already resolve country).
- Admin endpoints: summary, top pages (paginated), exit pages
  (paginated), funnel, recent visitors (paginated), per-visitor
  profile + journey.
- Admin UI: summary tiles, funnel bars, top + exit page tables,
  recent visitors table with clickable profile drawer.
- Licence verification via `@huloglobal/vendure-licence-sdk` with revocation
  polling.
