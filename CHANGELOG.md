# Changelog

All notable changes to `@huloglobal/vendure-plugin-visitor-analytics` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-07-04

### Added
- Boot-time compatibility check via the new SDK helper
  `warnIfIncompatibleVendure()`. Logs a non-fatal warning when the runtime
  `@vendure/core` version is outside the tested range. Silent when inside;
  fail-open on unparseable versions.

### Changed
- Peer dep on `@vendure/core` tightened to `>=3.5.0 <4.0.0` — Vendure 3.5,
  3.6 and 3.7 are all covered. Anything under 3.5 has never been tested;
  anything from 4.0 upwards is deferred until the changelog is reviewed.
- Uses `@huloglobal/vendure-licence-sdk@^0.6.0`.

## [0.6.0] — 2026-06-23

### Added
- Vendure Admin API GraphQL extensions. Operator endpoints are now
  first-class GraphQL queries alongside the existing REST admin
  endpoints: `huloVisitorSummary`, `huloVisitorSources`,
  `huloVisitorTopPages`, `huloVisitorFunnel`, `huloVisitorJourney`.
- Storefront path (`POST /ees/track`) stays REST — it's anonymous,
  high-frequency, and can ingest millions of events a day; the
  resolver stack would add pointless overhead per event.

## [0.5.0] — 2026-06-23

### Added
- Tier-gating on every premium feature via the SDK's `isLicensed()`
  helper. Unlicensed installs get:
  - a hard 100 events / UTC day cap on `POST /ees/track` (returns
    `{skipped: 'free-tier-cap'}` after that);
  - live SSE feed 402;
  - conversion-goal creation 402;
  - CSV export 402.
- Anti-tamper heartbeat via the SDK.

### Changed
- Relicensed the GitHub source to AGPL-3.0. Published npm builds remain
  under the commercial licence documented at
  <https://huloglobal.com/legal/terms/>.
- npm builds now include Sigstore provenance attestations.

## [0.4.3] — 2026-06-21

### Fixed
- Dropped the conflicting `display: block` on mobile tables that broke
  the row / cell alignment.

## [0.4.2] — 2026-06-21

### Changed
- 44px minimum tap targets on every interactive element in the admin UI.

## [0.4.1] — 2026-06-21

### Changed
- Comprehensive README refresh — documents the full v0.4 feature set
  with the storefront snippet, every privacy + security option, and
  the conversion-goals API.

## [0.4.0] — 2026-06-20

### Added
- Signed visitor + session cookies via the licence-sdk `signValue` /
  `verifySignedValue` helpers — tampered cookies are rejected.
- `Secure` cookie flag is set automatically when serving over HTTPS.
- Rate limiter (240 requests / 60s default) on `POST /ees/track`.
- `corsAllowedOrigins` option restricts CORS reflection to the
  configured list (legacy wildcard preserved when empty).
- Security headers on every response.
- Opt-in retention sweeper via `options.retention`.

## [0.3.3] — 2026-06-20

### Changed
- Mobile-friendly admin UI — summary cards reflow, tables scroll inside
  their card, profile drawer goes full-width.

## [0.3.2] — 2026-06-20

### Changed
- Republish targeting `@huloglobal/vendure-licence-sdk@^0.2.0`.

## [0.3.1] — 2026-06-20

### Added
- `UpdateChecker` integration — `/ees/visitors/status` endpoint returns
  version + update info; admin banner appears on new releases.

## [0.3.0] — 2026-06-20

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

## [0.2.0] — 2026-06-19

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

## [0.1.0] — 2026-06-19

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
- Licence verification via `@huloglobal/vendure-licence-sdk` with
  revocation polling.

[0.7.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.7.0
[0.6.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.6.0
[0.5.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.5.0
[0.4.3]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.4.3
[0.4.2]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.4.2
[0.4.1]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.4.1
[0.4.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.4.0
[0.3.3]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.3.3
[0.3.2]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.3.2
[0.3.1]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.3.1
[0.3.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.3.0
[0.2.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.2.0
[0.1.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.1.0
