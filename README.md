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
