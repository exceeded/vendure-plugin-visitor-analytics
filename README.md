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

14-day free trial (card required, start it from the admin — nothing charged until day 15), then **£9.95/month**, or **£199 one-off lifetime** at
[elite.charity/licence/buy/vendure-plugin-visitor-analytics](https://elite.charity/licence/buy/vendure-plugin-visitor-analytics).
Start the trial (or buy) from the plugin's admin page — checkout opens in a new tab and the key installs itself.

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
                // Opt-out link signing (0.18.0). Falls back to
                // recoveryLinkSecret, then signingSecret.
                optOutSecret: process.env.HULO_ABANDONMENT_OPTOUT_SECRET,
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
| `hulo.resumeCart(token)` | same route, when you can resume the visitor's open order | as above, plus `resumeOrderCode` while the bound order is still open (0.18.0) |
| `hulo.recoveryConverted(orderCode)` | on the thank-you page | attributes the order to the recovery link the visitor arrived through (0.18.0) |

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
   (or `POST /ees/recover-cart/resume?t=<token>` — see below)
3. Re-adds each `{ variantId, qty }` via your Vendure order API (usually
   `addItemToOrder(productVariantId, quantity)`) — check the result is an
   `Order`, not an `ErrorResult` (out of stock, purchase limit…)
4. Shows the basket when done — open your cart drawer or navigate to your
   cart page, whichever your storefront has (don't assume a `/cart` route)
5. On the thank-you page, calls `hulo.recoveryConverted(order.code)` (or
   `POST /ees/recover-cart/converted { t, orderCode }`) so the cart is
   attributed to the link — the helper remembers `t` in `sessionStorage`
   from step 2, so this is a no-op for visitors who did not arrive through
   a recovery link

**Resuming the visitor's order (0.18.0).** When the host mints the link
with `issueRecoveryLink(id, { resumeOrderCode })`, both recovery endpoints
return `orderCode`, `orderState` and `resumable`, and the `resume` endpoint
adds `resumeOrderCode` — non-null only while that order is still in
`AddingItems` / `ArrangingPayment`. The Shop API cannot adopt an order
anonymously, so treat it as a hint: a signed-in owner already has it as
their active order (skip the re-add), a guest gets the items re-added as
usual. Either way the `items` array is always present as the fallback.

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

Multi-storefront installs: set `abandonment.storefrontBaseUrls` to a map of
channel code → storefront origin (for example
`{ licensedock: 'https://license-dock.com' }`) and each cart's link points
at the storefront it was abandoned on; channels not listed fall back to
`storefrontBaseUrl`.

Set `abandonment.recoveryLinkSecret` in plugin options to enable this —
without it, the endpoint returns `{ error: 'recovery-disabled-or-not-found' }`.

**Attribution (0.18.0).**
Every `abandoned_cart` row carries `recoveryStep` — `link_issued` →
`link_opened` → `resumed` → `converted`, never moving backwards — plus
`convertedAt`, `convertedOrderId`, `convertedOrderCode` and
`resumeOrderCode`. Steps advance as the link is minted, exchanged
(`recover-cart`), resumed (`recover-cart/resume`) and finally reported
converted by the storefront (`POST /ees/recover-cart/converted
{ t, orderCode }` — token-bound, the order must exist and be past
`AddingItems`). The scanner's own `checkout_completed` match still marks
rows `converted` and stamps `convertedAt`, but leaves `recoveryStep`
alone — so "converted via link" is exactly `recoveryStep = 'converted'`.
`GET /ees/abandoned-carts/summary` returns an `attribution` block:

```json
{ "linkIssued": 120, "linkOpened": 41, "resumed": 9, "convertedViaLink": 14,
  "convertedViaLinkValueMinor": 184950, "convertedTotal": 37, "optOuts": 3 }
```

**Email opt-out (0.18.0).**
Recovery emails must carry an unsubscribe link. Build it with
`abandonedCartService.buildOptOutLink(email)` and add the headers from
`abandonedCartService.buildListUnsubscribeHeaders(email)`
(`List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`)
so Gmail / Outlook / Yahoo show their native "Unsubscribe" button. Both
point at `GET|POST /ees/abandoned-carts/opt-out?e=<token>` on the Vendure
server: GET renders a small confirmation page, POST is the RFC 8058
one-click form. The token is `base64url(email).hmac(email)` signed with
`abandonment.optOutSecret` (default: `recoveryLinkSecret`, then
`signingSecret`) — nobody can unsubscribe someone else.

Before every send call `await abandonedCartService.isOptedOut(email)`;
it fails closed (a DB error counts as opted out). Opt-outs live in
`abandoned_cart_opt_out` (keyed by the SHA-256 of the lower-cased
address). Admin: `GET /ees/abandoned-carts/opt-outs`,
`POST /ees/abandoned-carts/opt-outs/remove { email }` after an explicit
customer request; `GET /ees/abandoned-carts/:id` reports `optedOut`.

**Schema.** The 0.18.0 columns and the opt-out table are added at boot
with `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` (MariaDB
and PostgreSQL). Installs that run TypeORM migrations for plugins can
generate one as usual — the `AbandonedCart` entity declares the same
columns, so the generator finds nothing to add once the plugin has booted.

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
| `GET`  | `/ees/recover-cart?t=<token>` | resolve a recovery token → items (+ `orderCode`, `orderState`, `resumable` since 0.18.0); 30/min per IP |
| `POST` | `/ees/recover-cart/resume?t=<token>` | as above plus `resumeOrderCode` while the bound order is open (0.18.0); 30/min per IP |
| `POST` | `/ees/recover-cart/converted` | `{ t, orderCode }` — attribute a placed order to its recovery link (0.18.0); 10/min per IP |
| `GET`/`POST` | `/ees/abandoned-carts/opt-out?e=<token>` | email opt-out; POST is RFC 8058 one-click (0.18.0); 10/min per IP |
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
| `POST` | `/ees/abandoned-carts/:id/recovery-link` | mint signed URL (0.8.0, `UpdateCustomer`); body `{ resumeOrderCode? }` binds it to an order (0.18.0) |
| `GET`  | `/ees/abandoned-carts/opt-outs` | opted-out addresses (0.18.0) |
| `POST` | `/ees/abandoned-carts/opt-outs/remove` | `{ email }` — re-enable after an explicit request (0.18.0, `UpdateCustomer`) |
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
