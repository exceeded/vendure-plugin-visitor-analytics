# Changelog

All notable changes to `@huloglobal/vendure-plugin-visitor-analytics` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.2] — 2026-07-04

### Documentation
- README rewritten to cover every 0.8.x feature: the drop-in
  `/ees/hulo.js` storefront helper, cart-abandonment configuration
  and lifecycle, recommendation endpoints, search analytics,
  journey drawer buffs. Includes a walkthrough of the
  storefront-side `/cart/restore` route customers implement to
  consume recovery links.
- Endpoints table split into Public (browser-safe, CORS-permissive)
  vs Admin, with every 0.8.0-introduced endpoint marked inline.
- No runtime changes — bumped to ship the new README with the npm
  tarball.

## [0.8.1] — 2026-07-04

### Added
- `/ees/hulo.js` — the plugin now serves a drop-in typed storefront
  helper at this path. One `<script src>` tag and every event API
  (`hulo.cartSnapshot`, `hulo.productView`, `hulo.search`,
  `hulo.checkoutCompleted`, `hulo.restoreCart`) is available on
  `window.hulo`. Handles batching, `sendBeacon` on unload, and
  installs auto rage-click + dead-click detectors. Served with a
  10-minute browser TTL + 24-hour stale-while-revalidate and
  permissive CORS so it works cross-origin from any storefront.

## [0.8.0] — 2026-07-04

### Added

**Cart abandonment — end-to-end.**
- New `AbandonedCart` entity, keyed on session id. One row per
  abandoned session, refreshed in place until it either converts
  (order placed) or expires (recovery window elapses).
- `AbandonedCartService.scan()` — periodic sweep finds sessions with
  `cart_snapshot` events but no `checkout_completed` in the
  abandonment window (default 30 min). Auto-promotes previously
  abandoned rows to `converted` when the customer later checks out.
- Ships with a boot-time timer (worker-only, 5-minute cadence).
  Idempotent — safe to horizontally scale, only the worker runs it.
- Signed recovery links — `POST /ees/abandoned-carts/:id/recovery-link`
  returns a time-bounded opaque token the storefront exchanges via
  `GET /ees/recover-cart?t=…` to rebuild the exact cart. Storefront
  never sees the underlying items until the token is presented.
- Slack notification for high-value abandonments — configurable
  threshold and webhook via the `abandonment` plugin option.
- Admin API:
  - `GET  /ees/abandoned-carts` — paginated list with status,
    value and email filters.
  - `GET  /ees/abandoned-carts/summary` — totals, recovery rate,
    recovered vs. lost value in the window.
  - `GET  /ees/abandoned-carts/:id` — detail incl. parsed items.
  - `POST /ees/abandoned-carts/:id/status` — mark recovered /
    dismissed / re-open.
  - `GET  /ees/abandoned-carts/export.csv` — CSV export.

**Co-view product recommendations.**
- New `ProductCoView` aggregate table. Scanner walks recent
  `product_view` events per session, extracts every ordered pair,
  and increments a per-triple counter. Bounded to 20 events per
  session so runaway bot sessions can't skew the table.
- Denormalised — both `(A, B)` and `(B, A)` stored — so read-side
  lookups are one indexed scan.
- Runs every 6 hours on the worker; also exposed as
  `GET /ees/recommendations/aggregate-now` for admins to kick a
  fresh run after a data backfill.
- Public read endpoints (safe from the storefront):
  - `GET /ees/recommendations/also-viewed?productId=…` — the
    "customers who viewed X also viewed…" rail on a product page.
  - `GET /ees/recommendations/personal?visitorId=…` — personalised
    recs for a returning visitor, from their last 10 product views
    over 30 days. Excludes seeds.
  - `GET /ees/recommendations/trending?hours=24` — most-viewed
    products in the window. Reflects real interest, not search-
    console clicks.

**Site search analytics.**
- Reads back over `visitor_event` where the storefront has fired
  `hulo.search(query, resultsCount)`. Zero new schema.
- `GET /ees/search-analytics/top` — top queries by volume with
  average results count.
- `GET /ees/search-analytics/no-results` — top zero-result queries.
  Direct catalogue-gap intel.
- `GET /ees/search-analytics/conversion` — of sessions that
  searched, what fraction went on to fire `add_to_cart`.

**Journey drawer buffs.**
- Rage-click + dead-click aggregation, keyed on URL. Store-wide
  hot-spot lists for pages where visitors are stuck or frustrated.
- Per-visitor session summary with a heuristic `intent` label
  (`purchase` / `abandon` / `frustrate` / `consider` / `browse` /
  `bounce`) computed from event history — one glance per session
  in the Journey drawer instead of scrolling event rows.

**Storefront helper events (documented in the README).**
- `hulo.cartSnapshot({ currency, totalMinor, itemCount, items, email })`
- `hulo.productView(productId, productVariantId?)`
- `hulo.search(query, resultsCount)`
- `hulo.rageClick(url, selector?)` / `hulo.deadClick(url, selector)`
- `hulo.checkoutCompleted()`
- All flow into the existing `POST /ees/track` endpoint with a
  standard shape, so admins can also fire them from any language.

### Changed
- `checkout_completed` is now a first-class recognised event type
  — the abandonment scanner uses it to auto-close matched rows.

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

[0.8.2]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.8.2
[0.8.1]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.8.1
[0.8.0]: https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v0.8.0
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
