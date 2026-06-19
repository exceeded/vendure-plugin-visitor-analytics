# Changelog

All notable changes to `@hulo/vendure-plugin-visitor-analytics` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this
project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
- Licence verification via `@hulo/vendure-licence-sdk` with revocation
  polling.
