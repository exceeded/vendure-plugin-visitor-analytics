# @huloglobal/vendure-plugin-visitor-analytics

Self-hosted full-funnel visitor analytics for Vendure storefronts.
Pageviews, time-on-page, exit pages, configurable funnel, UTM
attribution, conversion goals with URL-glob matching, bot detection,
and a per-visitor profile drawer with parsed user-agent and MaxMind
geo. Privacy-first defaults: DNT, IP anonymisation, optional consent
gate.

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
        }),
    ],
};
```

Add `VisitorAnalyticsPlugin.uiExtensions` to your `compileUiExtensions`
config.

## Storefront snippet

```ts
// utils/visitor-tracking.ts
const ENDPOINT = 'https://shop.example.com/ees/track';
const CHANNEL_ID = 1;
let queue: any[] = [];
let flushTimer: any;

export function recordPageview(url: string, title: string) {
    queue.push({ type: 'pageview', url, title, clientTs: Date.now() });
    scheduleFlush();
}

export function recordEvent(type: string, meta: any) {
    queue.push({
        type, url: location.pathname + location.search,
        meta, clientTs: Date.now(),
    });
    scheduleFlush();
}

function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1000);
}
function flush() {
    if (!queue.length) return;
    const body = JSON.stringify({ channelId: CHANNEL_ID, events: queue });
    queue = [];
    navigator.sendBeacon?.(ENDPOINT, body) ||
        fetch(ENDPOINT, {
            method: 'POST', body,
            headers: { 'content-type': 'application/json' }, keepalive: true,
        });
}
```

Call `recordPageview()` on every route change. For custom events
(add-to-cart, search, signup, …) call `recordEvent(type, meta)` at the
appropriate point.

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

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/ees/track` | public | ingest batch of events |
| `GET` | `/ees/visitors/summary` | admin | top-line + daily series |
| `GET` | `/ees/visitors/sources` | admin | top sources by visits |
| `GET` | `/ees/visitors/top-pages` | admin | most-visited URLs |
| `GET` | `/ees/visitors/funnel` | admin | configurable funnel |
| `GET` | `/ees/visitors/exit-pages` | admin | top exit pages |
| `GET` | `/ees/visitors/top-events` | admin | top custom events |
| `GET` | `/ees/visitors/live` | admin | SSE live-now stream |
| `GET` | `/ees/visitors/journey/:visitorId` | admin | per-visitor timeline |
| `GET` | `/ees/visitors/recent` | admin | recent events |
| `GET` | `/ees/visitors/export.csv` | admin | CSV export |
| `GET` | `/ees/goals` | admin | list conversion goals |
| `POST` | `/ees/goals` | admin | create a goal |
| `PUT` | `/ees/goals/:id` | admin | update a goal |
| `DELETE` | `/ees/goals/:id` | admin | delete a goal |
| `GET` | `/ees/goals/stats` | admin | per-goal completion stats |
| `GET` | `/ees/visitors/status` | admin | version + update status |

## Documentation

User manual + screenshots:
[huloglobal.com/vendure-plugins/visitor-analytics/docs/](https://huloglobal.com/vendure-plugins/visitor-analytics/docs/)

## Lost your licence key?

Re-send every active key on file at
[elite.charity/licence/forgot](https://elite.charity/licence/forgot).

## Licence

Commercial. Buy at
[elite.charity/licence/buy/vendure-plugin-visitor-analytics](https://elite.charity/licence/buy/vendure-plugin-visitor-analytics).
