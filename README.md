# @huloglobal/vendure-plugin-visitor-analytics

Self-hosted full-funnel visitor analytics for Vendure storefronts.
Pageviews, time-on-page, exit pages, configurable funnel, UTM
attribution, conversion goals with URL-glob matching, bot detection,
and a per-visitor profile drawer with parsed user-agent and MaxMind
geo. Privacy-first defaults: DNT, IP anonymisation, optional consent
gate.

Since 0.8.0 the plugin also ships **cart abandonment** (detection,
signed recovery links, Slack notification, admin dashboard),
**co-view product recommendations** (`also-viewed` / `personal` /
`trending`), **site search analytics** (top queries, zero-result
queries, search-to-cart conversion) and **journey-drawer buffs**
(rage-click + dead-click hot-spot lists, per-session `intent`
labels).

Maintained by Wayne Garrison.

## Buy

7-day free trial then **£9.95/month**, or **£199 one-off lifetime** at
[elite.charity/licence/buy/vendure-plugin-visitor-analytics](https://elite.charity/licence/buy/vendure-plugin-visitor-analytics).

## Install

```bash
yarn add @huloglobal/vendure-plugin-visitor-analytics
```

```ts
import { VisitorAnalyticsPlugin } from '@huloglobal/vendure-plugin-visitor-analytics';

export const config: VendureConfig = {
    plugins: [
        VisitorAnalyticsPlugin.init({
            publicBaseUrl: 'https://shop.example.com',
            licenceKey: process.env.HULO_LICENCE_KEY_VISITOR_ANALYTICS,

            // -- Privacy (defaults shown) --
            honorDoNotTrack: true,
            anonymizeIp: true,
            requireConsent: false,
            dropBotEvents: false,

            // -- Security (recommended in production) --
            signingSecret: process.env.HULO_VISITOR_SIGNING_SECRET,
            corsAllowedOrigins: [
                'https://shop.example.com',
                'https://www.example.com',
            ],
            rateLimit: { capacity: 240, windowMs: 60_000 },

            // -- Retention (opt-in) --
            retention: { days: 365, maxRows: 50_000_000 },

            // -- Cart abandonment (opt-in, since 0.8.0) --
            // Storefront must fire cart_snapshot events (see below).
            abandonment: {
                windowMinutes: 30,
                slackMinValueMinor: 5000,
                slackWebhookUrl: process.env.HULO_ABANDONMENT_SLACK_URL,
                recoveryLinkSecret: process.env.HULO_ABANDONMENT_SECRET,
                recoveryLinkTtlHours: 72,
                storefrontBaseUrl: 'https://shop.example.com',
            },
        }),
    ],
};
```

Add `VisitorAnalyticsPlugin.uiExtensions` to your `compileUiExtensions`
config to pick up the Abandoned Carts + Analytics Insights admin pages.

## Storefront helpers

The plugin ships a **drop-in JS helper** at `/ees/hulo.js` — one script
tag and every event API below is available on `window.hulo`. It handles
batching, `sendBeacon` on unload, auto rage-click + dead-click
detection, and an on-mount `pageview`. Bare minimum:

```html
<script src="https://shop.example.com/ees/hulo.js" defer></script>
```

For a first-party integration (recommended — one bundle instead of a
second script tag), copy the equivalent typed helpers into your
storefront. The [elite.charity Qwik storefront](https://elite-software.co.uk)
uses this pattern. Every helper below is a thin wrapper around
`POST /ees/track` with a specific `meta.eventType` — the plugin's
server-side scanners look those event types up by name.

| Helper | When to call | What it feeds |
| --- | --- | --- |
| `hulo.pageview()` | first mount + every route change | pageview funnel, exit-page report |
| `hulo.productView(productId, variantId?)` | on the PDP | co-view aggregation, `also-viewed`, `trending`, `personal` recs |
| `hulo.addToCart(variantId, qty, unitPriceMinor)` | on the "add" button | search-to-cart conversion |
| `hulo.cartSnapshot({ currency, totalMinor, itemCount, items, email? })` | every cart change (add / remove / qty) | **cart abandonment detection** |
| `hulo.search(query, resultsCount)` | on every executed search | top-queries, zero-result queries |
| `hulo.checkoutCompleted(orderCode, totalMinor)` | on the thank-you page | closes any open `abandoned_cart` row for this session |
| `hulo.rageClick(selector)` / `hulo.deadClick(selector)` | fire yourself if you have a better signal than the auto-detector | rage-click / dead-click hot-spot lists |
| `hulo.restoreCart(token)` | on your `/cart/restore?t=...` route | rebuild a cart from a signed recovery link |

Full payload shapes:

```ts
hulo.cartSnapshot({
    currency: 'GBP',              // ISO-4217
    totalMinor: 4995,             // in pence / cents
    itemCount: 2,
    items: [
        { variantId: 42, name: 'Blue T-shirt (M)', qty: 1, unitPriceMinor: 1995, sku: 'BT-M' },
        { variantId: 88, name: 'Wool socks',        qty: 1, unitPriceMinor: 3000 },
    ],
    email: 'buyer@example.com',   // optional — captured at checkout step 1
    countryCode: 'GB',            // optional
});

hulo.productView(product.id, selectedVariant.id);
hulo.search('rgb keyboard', 42);           // (query, resultsCount)
hulo.checkoutCompleted('S2BZ54TEK', 12500); // (orderCode, totalMinor)
```

### Cart-restore route

The recovery link the admin mints (see below) lands on
`https://shop.example.com/cart/restore?t=<token>`. Your storefront
needs a route that:

1. Reads `?t=` from the URL
2. Calls `GET /ees/recover-cart?t=<token>` to fetch `{ items: [...] }`
3. Re-adds each `{ variantId, qty }` via your Vendure order API (usually
   `addItemToOrder(productVariantId, quantity)`)
4. Navigates to `/cart` when done

Guard against silently overwriting a live cart — if the visitor
already has items, show a "you already have items in your cart"
message and let them reconcile. See
[elite.charity's `src/routes/cart/restore/index.tsx`](https://github.com/exceeded/elite-software-frontend/blob/main/src/routes/cart/restore/index.tsx)
for a working reference implementation.

### Legacy: hand-rolled tracker

If you prefer to skip `/ees/hulo.js`, the raw POST shape is unchanged:

```ts
const body = JSON.stringify({
    channelId: 1,
    events: [{
        type: 'event',
        url: location.href,
        meta: { eventType: 'product_view', productId: 42 },
    }],
});
navigator.sendBeacon('/ees/track', body) ||
    fetch('/ees/track', {
        method: 'POST', body, credentials: 'include',
        headers: { 'content-type': 'application/json' }, keepalive: true,
    });
```

## Feature tour

### Lightweight ingest

- `POST /ees/track` accepts a batch of up to 50 events at once.
- Visitor + session cookies (`ees_vid`, `ees_sid`) issued + refreshed
  automatically. When `signingSecret` is set, cookies are HMAC-signed
  and tampered values are rejected — the visitor gets a fresh id.
- `Secure` flag is set automatically when serving over HTTPS.

### Auto-enrichment

Per event:

- **User-agent** parsed via `ua-parser-js` → browser, version, OS,
  device.
- **Geo** via MaxMind GeoLite2-City (no MaxMind account required — DB
  fetched at install via `geolite2-redist`). Skipped when the upstream
  proxy already provides a country (Cloudflare, Akamai, Fastly).
- **UTM attribution** parsed server-side from every pageview URL:
  `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent`. Plus
  `referrerDomain` for grouping by source even when UTM is absent.
- **Bot flag** — known crawler / monitoring / library UAs (Googlebot,
  Bingbot, UptimeRobot, Datadog, curl, Puppeteer, …) marked `isBot=true`.

### Configurable conversion goals

A goal is a URL glob that, when matched, counts the visitor as having
converted. Supports `*` (within segment) and `**` (across segments).

```bash
curl -X POST https://shop.example.com/ees/goals -H 'content-type: application/json' \
  -d '{"channelId":1,"name":"Checkout completed","urlPattern":"/checkout/thank-you/*","valueMinor":5000}'
```

Stats at `GET /ees/goals/stats?days=30&channelId=1`.

### Privacy controls

- `honorDoNotTrack: true` (default) — `DNT: 1` and `Sec-GPC: 1` requests
  get a 200 with `{stored:0, skipped:'dnt'}`.
- `anonymizeIp: true` (default) — IPv4 last octet dropped before
  storage; IPv6 reduced to the first 3 hextets. `ipHash` still uses the
  raw IP so unique-visitor counts stay accurate.
- `requireConsent: false` (default) — flip on to require a `consent: true`
  body field or an `ees_consent=1` cookie before ingest.
- `dropBotEvents: false` (default) — flip on to skip bot UAs entirely.

### Cart abandonment (since 0.8.0)

Detects sessions that got as far as putting items in the cart but
never fired `checkout_completed`. Turns them into `AbandonedCart` rows
you can send a recovery email against.

**How detection works.**
The plugin runs a worker-only sweep every 5 minutes. It looks at every
session that fired at least one `cart_snapshot` event, and:

- If a `checkout_completed` landed later — do nothing (or if an
  `abandoned_cart` row already exists, promote it to `converted`).
- If the last `cart_snapshot` is older than `abandonment.windowMinutes`
  (default 30) — open an `abandoned_cart` row, keyed on `sessionId`
  (unique — you can't double-open the same session).
- Otherwise leave the session alone. It may still convert.

**Recovery link.**
`POST /ees/abandoned-carts/:id/recovery-link` mints a signed opaque
token and returns `{ ok: true, url: '<storefront>/cart/restore?t=...' }`.
The token is time-bounded (`recoveryLinkTtlHours`, default 72) and
non-reusable. The storefront exchanges it via
`GET /ees/recover-cart?t=<token>` to get back the persisted item list.

Set `abandonment.recoveryLinkSecret` in plugin options to enable this —
without it, the endpoint returns `{ error: 'recovery-disabled-or-not-found' }`.

**Slack notification.**
`abandonment.slackWebhookUrl` + `abandonment.slackMinValueMinor`
control an at-most-once Slack post per abandonment above the value
threshold. Useful for sales teams that follow up on high-value drops
manually.

**Admin dashboard.**
Under **Analytics → Abandoned carts**. Filters by status / min value /
email / window. Actions per row: mint recovery link (copies URL to
clipboard), mark recovered manually, dismiss. CSV export.

### Product recommendations (since 0.8.0)

A `ProductCoView` aggregate table holds a per-triple counter
`(productIdA, productIdB, channelId) → viewsTogether`. Rebuilt every 6
hours from the last 24h of `product_view` events, bounded to 20 events
per session so runaway bot sessions can't skew the table.
Denormalised — we store both `(A, B)` and `(B, A)` — so read-side
lookups are one indexed scan.

Three endpoints, all safe from the storefront (no PII):

| Endpoint | Use |
| --- | --- |
| `GET /ees/recommendations/also-viewed?productId=42&limit=10` | product-page rail: "customers who viewed X also viewed…" |
| `GET /ees/recommendations/personal?visitorId=abc&limit=10` | homepage / cart recs for a returning visitor. Uses their last 10 `product_view` events over 30 days, excludes the seeds so the same product never appears |
| `GET /ees/recommendations/trending?hours=24&limit=10` | homepage rail: most-viewed products in the window. Reflects real intent (not search-console clicks) |

`GET /ees/recommendations/aggregate-now` (SuperAdmin only) forces a
sweep — useful after a big backfill or spike.

### Site search analytics (since 0.8.0)

Zero-schema-cost queries over the existing `visitor_event` table where
the storefront has fired `hulo.search(query, resultsCount)` events.

| Endpoint | Use |
| --- | --- |
| `GET /ees/search-analytics/top?days=7` | top queries by volume with average results count |
| `GET /ees/search-analytics/no-results?days=7` | queries that returned zero hits — direct catalogue-gap intel |
| `GET /ees/search-analytics/conversion?days=7` | of sessions that searched, what fraction went on to `add_to_cart` |

### Journey drawer buffs (since 0.8.0)

| Endpoint | Use |
| --- | --- |
| `GET /ees/journey/rage-clicks?days=7` | rage-click hot-spot list per URL. Pages where visitors are frustrated |
| `GET /ees/journey/dead-clicks?days=7` | dead-click hot-spot list per URL. Elements that LOOK clickable but aren't |
| `GET /ees/journey/session-summary?visitorId=abc` | per-session summary with a heuristic `intent` label (`purchase` / `abandon` / `frustrate` / `consider` / `browse` / `bounce`) |

Rage-click auto-detector fires on ≥3 pointerdown events within 500ms
and a 20-pixel radius. Dead-click auto-detector fires when a click
lands on a non-interactive element and no navigation / significant
scroll follows within 400ms. Both are conservative heuristics — the
signal is direction-of-frustration, not a metric to optimise against.

### Live-now widget

SSE stream at `GET /ees/visitors/live` pushes the active-visitor count
and the 20 most recent URLs every 5 seconds. Auto-reconnects.

### Per-visitor journey

Click any visitor for the full timeline: pages, custom events,
time-on-page, country, browser, OS.

### CSV export

`GET /ees/visitors/export.csv?days=N` (max 90 days) returns the raw
events with full enrichment.

## HTTP endpoints

**Public** (no auth — CORS-permissive for browser calls from any
storefront origin):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/ees/track` | ingest a batch of visitor events |
| `GET`  | `/ees/hulo.js` | typed storefront helper JS (since 0.8.1) |
| `GET`  | `/ees/recover-cart?t=<token>` | resolve a recovery token → items |
| `GET`  | `/ees/recommendations/also-viewed?productId=…` | co-view recs |
| `GET`  | `/ees/recommendations/personal?visitorId=…` | personalised recs |
| `GET`  | `/ees/recommendations/trending?hours=…` | most-viewed products |

**Admin** (Vendure `ReadCustomer` unless noted; requires a
Vendure admin session cookie):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/ees/visitors/summary` | top-line + daily series |
| `GET`  | `/ees/visitors/sources` | top sources by visits |
| `GET`  | `/ees/visitors/top-pages` | most-visited URLs |
| `GET`  | `/ees/visitors/funnel` | configurable funnel |
| `GET`  | `/ees/visitors/exit-pages` | top exit pages |
| `GET`  | `/ees/visitors/top-events` | top custom events |
| `GET`  | `/ees/visitors/live` | SSE live-now stream |
| `GET`  | `/ees/visitors/journey/:visitorId` | per-visitor timeline |
| `GET`  | `/ees/visitors/recent` | recent events |
| `GET`  | `/ees/visitors/export.csv` | CSV export |
| `GET`  | `/ees/goals` | list conversion goals |
| `POST` | `/ees/goals` | create a goal |
| `PUT`  | `/ees/goals/:id` | update a goal |
| `DELETE`| `/ees/goals/:id` | delete a goal |
| `GET`  | `/ees/goals/stats` | per-goal completion stats |
| `GET`  | `/ees/visitors/status` | version + update status |
| `GET`  | `/ees/abandoned-carts` | paginated list w/ filters (0.8.0) |
| `GET`  | `/ees/abandoned-carts/summary` | totals + recovery rate (0.8.0) |
| `GET`  | `/ees/abandoned-carts/:id` | detail incl. parsed items (0.8.0) |
| `POST` | `/ees/abandoned-carts/:id/recovery-link` | mint signed URL (0.8.0, `UpdateCustomer`) |
| `POST` | `/ees/abandoned-carts/:id/status` | mark recovered/dismissed (0.8.0, `UpdateCustomer`) |
| `GET`  | `/ees/abandoned-carts/export.csv` | CSV export (0.8.0) |
| `GET`  | `/ees/recommendations/aggregate-now` | force co-view sweep (0.8.0, `SuperAdmin`) |
| `GET`  | `/ees/search-analytics/top` | top queries (0.8.0) |
| `GET`  | `/ees/search-analytics/no-results` | zero-result queries (0.8.0) |
| `GET`  | `/ees/search-analytics/conversion` | search→cart rate (0.8.0) |
| `GET`  | `/ees/journey/rage-clicks` | rage-click hot spots (0.8.0) |
| `GET`  | `/ees/journey/dead-clicks` | dead-click hot spots (0.8.0) |
| `GET`  | `/ees/journey/session-summary?visitorId=…` | per-session intent labels (0.8.0) |

## Documentation

User manual + screenshots:
[huloglobal.com/vendure-plugins/visitor-analytics/docs/](https://huloglobal.com/vendure-plugins/visitor-analytics/docs/)

## Lost your licence key?

Re-send every active key on file at
[elite.charity/licence/forgot](https://elite.charity/licence/forgot).

## Licence

Commercial. Buy at
[elite.charity/licence/buy/vendure-plugin-visitor-analytics](https://elite.charity/licence/buy/vendure-plugin-visitor-analytics).
