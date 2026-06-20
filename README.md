# @hulo/vendure-plugin-visitor-analytics

Full-funnel visitor analytics for Vendure storefronts. Captures every
pageview, time-on-page, and exit point; bundles a per-visitor profile
drawer with parsed user-agent, MaxMind geo enrichment and a complete
event timeline; stitches guest browsing to signed-in browsing across
sessions so the journey survives login.

Maintained by Wayne Garrison.

## What you get

- **Ingest endpoint** at `POST /ees/track` that takes a small batch of
  events from the storefront. Issues a long-lived visitor cookie
  (`ees_vid`, 2 years) and a sliding session cookie (`ees_sid`,
  30-minute idle).
- **Auto-enrichment** at ingest time:
  - User-agent parsed via `ua-parser-js` → browser / browser version /
    OS / OS version / device type. Bots auto-detected.
  - IP-to-geo via MaxMind GeoLite2-City (no MaxMind account required,
    DB fetched at install via `geolite2-redist`). Or use the upstream
    proxy's resolved country / region when Cloudflare / Akamai /
    Fastly is in front — saves the lookup.
  - Raw IP is kept; a SHA-256 salted hash is stored alongside for
    spot-the-same-bot work.
- **Admin endpoints**: summary tiles, top pages, exit pages, funnel,
  recent visitors, per-visitor profile + journey timeline. All
  paginated.
- **Admin UI**: top-line tiles, funnel bars, top + exit page tables,
  recent visitors with a clickable profile drawer showing every field
  + per-session breakdown + the full event timeline.

## Install

```bash
yarn add @hulo/vendure-plugin-visitor-analytics
```

## Wire up

```ts
import { VisitorAnalyticsPlugin } from '@hulo/vendure-plugin-visitor-analytics';

export const config: VendureConfig = {
  plugins: [
    VisitorAnalyticsPlugin.init({
      publicBaseUrl: 'https://shop.example.com',
      licenceKey: process.env.HULO_LICENCE_KEY,
    }),
  ],
};
```

Add to your admin-ui compile step:

```ts
import { VisitorAnalyticsPlugin } from '@hulo/vendure-plugin-visitor-analytics';

compileUiExtensions({
  outputPath: 'admin-ui',
  extensions: [VisitorAnalyticsPlugin.uiExtensions /* + your other extensions */],
});
```

## Storefront integration

The plugin ships only the backend; the storefront emits events. A Qwik
storefront example:

```ts
// utils/tracker.ts
const TRACK_URL = 'https://shop.example.com/ees/track';
let lastPath = '';
let pageOpenedAt = 0;

export function recordPageView(): void {
  const url = location.pathname + location.search;
  const events: any[] = [];
  if (lastPath && lastPath !== url) {
    events.push({ type: 'unload', url: lastPath, timeOnPageMs: Date.now() - pageOpenedAt });
  }
  events.push({ type: 'pageview', url, title: document.title, referrer: document.referrer });
  lastPath = url;
  pageOpenedAt = Date.now();
  fetch(TRACK_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: 1, events }),
    keepalive: true,
  }).catch(() => undefined);
}

// On unload, prefer sendBeacon — it survives tab-close.
window.addEventListener('pagehide', () => {
  const blob = new Blob([JSON.stringify({
    channelId: 1,
    events: [{ type: 'unload', url: lastPath, timeOnPageMs: Date.now() - pageOpenedAt }],
  })], { type: 'application/json' });
  navigator.sendBeacon(TRACK_URL, blob);
});
```

## Custom events

Fire a `recordEvent(type, meta?)` call from your storefront whenever a
visitor does something interesting — add-to-cart, search, signup,
quote-request — and the event shows up in the admin "Top events" table
straight away.

```ts
function recordEvent(type, meta) {
  navigator.sendBeacon(TRACK_URL, new Blob([JSON.stringify({
    channelId: 1,
    events: [{ type, url: location.pathname + location.search, meta }],
  })], { type: 'application/json' }));
}

// Add to cart
recordEvent('add_to_cart', { sku: 'WIN11-PRO', priceWithTax: 28900 });

// Search query submitted
recordEvent('search', { query: 'windows server 2022' });

// Quote request from the contact form
recordEvent('quote_request', { customerEmail });

// Newsletter signup
recordEvent('newsletter_signup', { source: 'footer' });
```

The full meta blob is persisted as JSON on the event row so you can
slice on it later from the admin UI.

## UTM attribution

The plugin parses `utm_source` / `utm_medium` / `utm_campaign` /
`utm_term` / `utm_content` from the URL of every incoming event and
captures the referrer domain alongside. The admin "Traffic sources"
table groups visitors by `(source, medium)` so you can see which
campaigns convert.

Drop `?utm_source=google&utm_medium=cpc&utm_campaign=spring24` onto any
inbound link and it surfaces automatically — no extra config.

## Live now widget

The admin dashboard's top tile streams the currently-active visitor
count + the URLs they're on in real time via Server-Sent Events
(`GET /ees/visitors/live`). Updates every 5 seconds, reconnects
automatically if the connection drops. Active = at least one event in
the last 5 minutes.

## Init options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `publicBaseUrl` | `string` | yes | Public hostname of your Vendure server (must match licence). |
| `licenceKey` | `string` | no* | JWT licence key. Without it ingest works but the admin dashboards return 403. |

\* Required for production use. Buy at
`https://elite-software.co.uk/licence/buy/vendure-plugin-visitor-analytics`.

## Licence

Commercial — see [LICENSE](./LICENSE). Requires an active subscription
($9.95/mo) or a perpetual licence.
