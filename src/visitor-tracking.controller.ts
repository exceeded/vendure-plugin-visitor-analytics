import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { Ctx, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import { Request, Response } from 'express';
import { VisitorEvent } from './visitor-event.entity';
import { VisitorTrackingService } from './visitor-tracking.service';

const COOKIE_VISITOR = 'ees_vid';
const COOKIE_SESSION = 'ees_sid';
const VISITOR_TTL_DAYS = 730;   // ~2 years
const SESSION_IDLE_MIN = 30;    // 30-minute idle session timeout

function requireAdmin(ctx: RequestContext, res: Response): boolean {
    if (!ctx?.activeUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return false;
    }
    if (!ctx.userHasPermissions([Permission.ReadCustomer])) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    return true;
}

function clampInt(raw: any, fallback: number, min: number, max: number): number {
    const n = parseInt(String(raw ?? fallback), 10);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

import { getRealIp, getResolvedCountry, getResolvedRegion } from './proxy-headers';
function realIp(req: Request): string | null { return getRealIp(req); }

@Controller('ees')
export class VisitorTrackingController {
    constructor(
        private connection: TransactionalConnection,
        private tracking: VisitorTrackingService,
    ) {}

    /**
     * Ingest endpoint hit by the storefront tracker. Anonymous, takes
     * a small JSON batch via fetch() or navigator.sendBeacon() (which
     * uses text/plain). CORS is open because the storefront is on a
     * different origin from the API.
     *
     *   POST /ees/track
     *   body: {
     *     channelId?: number,
     *     customerId?: number | null,
     *     events: [
     *       { type, url, title?, referrer?, timeOnPageMs?, meta?, clientTs? }
     *     ]
     *   }
     *
     * Cookies `ees_vid` (visitor) and `ees_sid` (session) are issued
     * on the first request and refreshed on every subsequent one.
     */
    @Post('track')
    async track(@Body() body: any, @Req() req: Request, @Res() res: Response) {
        // Lenient CORS — analytics ingestion must work cross-origin from
        // both storefronts (and dev hosts) without complex config.
        this.applyCors(req, res);
        if (req.method === 'OPTIONS') return res.status(204).end();

        const cookies = this.parseCookies(req);
        let visitorId = String(cookies[COOKIE_VISITOR] || '').slice(0, 64);
        let sessionId = String(cookies[COOKIE_SESSION] || '').slice(0, 64);
        let issuedVisitor = false;
        let issuedSession = false;
        if (!visitorId || !/^[a-f0-9]{16,64}$/i.test(visitorId)) {
            visitorId = this.tracking.newId();
            issuedVisitor = true;
        }
        if (!sessionId || !/^[a-f0-9]{16,64}$/i.test(sessionId)) {
            sessionId = this.tracking.newId();
            issuedSession = true;
        }

        const channelId = Number(body?.channelId) || 1;
        const customerId = body?.customerId != null ? Number(body.customerId) || null : null;
        const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : [];

        const ip = realIp(req);
        // Prefer the upstream proxy's resolved country / region (Cloudflare,
        // Akamai, Fastly all populate these headers when configured) — saves
        // the per-request MaxMind lookup. The service still falls back to a
        // GeoLite2 lookup if the proxy values are absent.
        const proxyCountry = getResolvedCountry(req);
        const proxyRegion = getResolvedRegion(req);

        const out = await this.tracking.ingest({
            visitorId, sessionId, customerId, channelId, events,
            ip,
            userAgent: req.headers['user-agent'] || null,
            acceptLanguage: (req.headers['accept-language'] as string) || null,
            proxyCountry, proxyRegion,
        });

        // Refresh cookies on every hit so the session window slides while
        // the visitor is active.
        const cookieOpts = (maxAgeSec: number) => `Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;
        res.setHeader('Set-Cookie', [
            `${COOKIE_VISITOR}=${visitorId}; ${cookieOpts(VISITOR_TTL_DAYS * 86400)}`,
            `${COOKIE_SESSION}=${sessionId}; ${cookieOpts(SESSION_IDLE_MIN * 60)}`,
        ]);

        return res.json({
            stored: out.stored,
            visitorId, sessionId,
            issuedVisitor, issuedSession,
        });
    }

    // ------------------------------------------------------------------
    // Admin reads — feed the Visitor Journey UI.
    // ------------------------------------------------------------------

    /** Top-line counters + daily series for the dashboard header. */
    @Get('visitors/summary')
    async summary(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = Math.min(Math.max(parseInt(String((req.query as any).days || '30'), 10) || 30, 1), 365);
        const rows = await this.connection.rawConnection.query(
            `SELECT DATE(createdAt) AS day,
                    COUNT(DISTINCT visitorId) AS visitors,
                    COUNT(DISTINCT sessionId) AS sessions,
                    COUNT(*) AS events,
                    SUM(type='pageview') AS pageviews
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY DATE(createdAt)
             ORDER BY day`,
            [days],
        );
        const [{ totalVisitors, totalSessions, totalPageviews, avgTimeMs }] = await this.connection.rawConnection.query(
            `SELECT COUNT(DISTINCT visitorId) AS totalVisitors,
                    COUNT(DISTINCT sessionId) AS totalSessions,
                    SUM(type='pageview')      AS totalPageviews,
                    AVG(CASE WHEN type='unload' AND timeOnPageMs > 0 THEN timeOnPageMs END) AS avgTimeMs
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [days],
        );
        return res.json({
            days,
            totals: {
                visitors: Number(totalVisitors) || 0,
                sessions: Number(totalSessions) || 0,
                pageviews: Number(totalPageviews) || 0,
                avgTimeMs: Math.round(Number(avgTimeMs) || 0),
            },
            daily: rows.map((r: any) => ({
                day: r.day,
                visitors: Number(r.visitors) || 0,
                sessions: Number(r.sessions) || 0,
                events: Number(r.events) || 0,
                pageviews: Number(r.pageviews) || 0,
            })),
        });
    }

    /** Traffic sources — UTM source breakdown + organic referrer
     *  domains. Visitors are attributed by their first-pageview's UTM
     *  / referrer combo per session. */
    @Get('visitors/sources')
    async sources(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = clampInt((req.query as any).days, 30, 1, 365);
        const take = clampInt((req.query as any).take, 25, 1, 500);
        const skip = clampInt((req.query as any).skip, 0, 0, 1_000_000);

        const rows = await this.connection.rawConnection.query(
            `SELECT source, medium, COALESCE(MAX(campaign), '') AS campaign,
                    COUNT(DISTINCT visitorId) AS visitors,
                    COUNT(DISTINCT sessionId) AS sessions,
                    SUM(reached_product) AS productViewers,
                    SUM(reached_checkout) AS checkoutReached
             FROM (
                 SELECT visitorId, sessionId,
                        COALESCE(utmSource, referrerDomain, '(direct)') AS source,
                        COALESCE(utmMedium, IF(referrerDomain IS NOT NULL, 'referral', 'none')) AS medium,
                        utmCampaign AS campaign,
                        MAX(CASE WHEN url LIKE '/products/%' AND type='pageview' THEN 1 ELSE 0 END) AS reached_product,
                        MAX(CASE WHEN (url LIKE '%/checkout%' OR url LIKE '%cart%') AND type='pageview' THEN 1 ELSE 0 END) AS reached_checkout
                 FROM visitor_event
                 WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
                 GROUP BY visitorId, sessionId,
                          COALESCE(utmSource, referrerDomain, '(direct)'),
                          COALESCE(utmMedium, IF(referrerDomain IS NOT NULL, 'referral', 'none')),
                          utmCampaign
             ) by_session
             GROUP BY source, medium
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
            [days, take, skip],
        );
        const [{ total }] = await this.connection.rawConnection.query(
            `SELECT COUNT(*) AS total FROM (
                SELECT DISTINCT
                    COALESCE(utmSource, referrerDomain, '(direct)') AS source,
                    COALESCE(utmMedium, IF(referrerDomain IS NOT NULL, 'referral', 'none')) AS medium
                FROM visitor_event
                WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
             ) sources`,
            [days],
        );
        return res.json({
            sources: rows.map((r: any) => ({
                source: r.source,
                medium: r.medium,
                campaign: r.campaign,
                visitors: Number(r.visitors) || 0,
                sessions: Number(r.sessions) || 0,
                productViewers: Number(r.productViewers) || 0,
                checkoutReached: Number(r.checkoutReached) || 0,
            })),
            total: Number(total) || 0, take, skip,
        });
    }

    /** Top pages by view count. Paginated via take + skip. */
    @Get('visitors/top-pages')
    async topPages(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = clampInt((req.query as any).days, 30, 1, 365);
        const take = clampInt((req.query as any).take, 25, 1, 500);
        const skip = clampInt((req.query as any).skip, 0, 0, 1_000_000);
        const rows = await this.connection.rawConnection.query(
            `SELECT url,
                    MAX(title)               AS title,
                    COUNT(*)                 AS views,
                    COUNT(DISTINCT visitorId) AS uniqueVisitors,
                    AVG(NULLIF(timeOnPageMs, 0)) AS avgTimeMs
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND type IN ('pageview', 'unload')
             GROUP BY url
             ORDER BY views DESC
             LIMIT ? OFFSET ?`,
            [days, take, skip],
        );
        const [{ total }] = await this.connection.rawConnection.query(
            `SELECT COUNT(DISTINCT url) AS total FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND type IN ('pageview', 'unload')`,
            [days],
        );
        return res.json({
            pages: rows.map((r: any) => ({
                url: r.url, title: r.title,
                views: Number(r.views) || 0,
                uniqueVisitors: Number(r.uniqueVisitors) || 0,
                avgTimeMs: Math.round(Number(r.avgTimeMs) || 0),
            })),
            total: Number(total) || 0, take, skip,
        });
    }

    /** Funnel: visitors → product views → cart → checkout completed. */
    @Get('visitors/funnel')
    async funnel(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = Math.min(Math.max(parseInt(String((req.query as any).days || '30'), 10) || 30, 1), 365);
        const stages = [
            { key: 'visited',    label: 'Any page',          where: `1=1` },
            { key: 'viewed',     label: 'Viewed a product',  where: `url LIKE '/products/%'` },
            { key: 'cart',       label: 'Opened the cart',   where: `url LIKE '%/checkout%' OR url LIKE '%cart%'` },
            { key: 'confirmed',  label: 'Reached checkout confirmation', where: `url LIKE '%/checkout/confirmation/%'` },
        ];
        const result: any[] = [];
        for (const s of stages) {
            const [{ n }] = await this.connection.rawConnection.query(
                `SELECT COUNT(DISTINCT visitorId) AS n FROM visitor_event
                 WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
                   AND type='pageview' AND (${s.where})`,
                [days],
            );
            result.push({ key: s.key, label: s.label, visitors: Number(n) || 0 });
        }
        return res.json({ days, stages: result });
    }

    /** Exit pages — pages where the last event in the session was a
     *  pageview. Paginated via take + skip. */
    @Get('visitors/exit-pages')
    async exitPages(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = clampInt((req.query as any).days, 30, 1, 365);
        const take = clampInt((req.query as any).take, 25, 1, 500);
        const skip = clampInt((req.query as any).skip, 0, 0, 1_000_000);
        const rows = await this.connection.rawConnection.query(
            `SELECT url,
                    MAX(title) AS title,
                    COUNT(*)   AS exits
             FROM (
                 SELECT sessionId, url, title, createdAt,
                        ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY createdAt DESC) AS rn
                 FROM visitor_event
                 WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
                   AND type='pageview'
             ) last_pages
             WHERE rn = 1
             GROUP BY url
             ORDER BY exits DESC
             LIMIT ? OFFSET ?`,
            [days, take, skip],
        );
        const [{ total }] = await this.connection.rawConnection.query(
            `SELECT COUNT(DISTINCT url) AS total FROM (
                SELECT sessionId, url,
                       ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY createdAt DESC) AS rn
                FROM visitor_event
                WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY) AND type='pageview'
             ) lp WHERE rn = 1`,
            [days],
        );
        return res.json({
            exitPages: rows.map((r: any) => ({
                url: r.url, title: r.title, exits: Number(r.exits) || 0,
            })),
            total: Number(total) || 0, take, skip,
        });
    }

    /** Top custom events — `type` other than pageview / unload. Useful
     *  for tracking add-to-cart / search / quote-request / signup
     *  conversion rates. Paginated. */
    @Get('visitors/top-events')
    async topEvents(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = clampInt((req.query as any).days, 30, 1, 365);
        const take = clampInt((req.query as any).take, 25, 1, 500);
        const skip = clampInt((req.query as any).skip, 0, 0, 1_000_000);
        const rows = await this.connection.rawConnection.query(
            `SELECT type,
                    COUNT(*) AS count,
                    COUNT(DISTINCT visitorId) AS uniqueVisitors,
                    COUNT(DISTINCT sessionId) AS sessions
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND type NOT IN ('pageview', 'unload')
             GROUP BY type
             ORDER BY count DESC
             LIMIT ? OFFSET ?`,
            [days, take, skip],
        );
        const [{ total }] = await this.connection.rawConnection.query(
            `SELECT COUNT(DISTINCT type) AS total FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND type NOT IN ('pageview', 'unload')`,
            [days],
        );
        return res.json({
            events: rows.map((r: any) => ({
                type: r.type,
                count: Number(r.count) || 0,
                uniqueVisitors: Number(r.uniqueVisitors) || 0,
                sessions: Number(r.sessions) || 0,
            })),
            total: Number(total) || 0, take, skip,
        });
    }

    /**
     * Live-now widget — Server-Sent Events stream pushing the current
     * active-visitor count + their most recent URLs every 5 seconds.
     * "Active" = at least one event in the last 5 minutes. SSE keeps
     * the connection open; the admin UI consumes it via `EventSource`.
     *
     * Each event payload:
     *   data: { ts, activeCount, recent: [{ visitorId, url, country, secondsAgo }] }
     */
    @Get('visitors/live')
    async live(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        res.flushHeaders?.();

        const tick = async () => {
            try {
                const rows = await this.connection.rawConnection.query(
                    `SELECT visitorId,
                            MAX(url) AS url,
                            MAX(country) AS country,
                            TIMESTAMPDIFF(SECOND, MAX(createdAt), NOW()) AS secondsAgo
                     FROM visitor_event
                     WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                       AND type = 'pageview'
                     GROUP BY visitorId
                     ORDER BY MAX(createdAt) DESC
                     LIMIT 20`,
                );
                const payload = {
                    ts: new Date().toISOString(),
                    activeCount: rows.length,
                    recent: rows.map((r: any) => ({
                        visitorId: r.visitorId,
                        url: r.url,
                        country: r.country,
                        secondsAgo: Number(r.secondsAgo) || 0,
                    })),
                };
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            } catch {
                // Don't kill the stream on transient DB errors — the next
                // tick will retry. SSE clients reconnect automatically
                // if the connection drops.
            }
        };

        // Fire immediately, then every 5s. Stop when the client disconnects.
        await tick();
        const interval = setInterval(() => { tick().catch(() => undefined); }, 5_000);
        req.on('close', () => clearInterval(interval));
        req.on('end',   () => clearInterval(interval));
    }

    /** Journey timeline for one visitor — every event in order. */
    @Get('visitors/journey/:visitorId')
    async journey(@Ctx() ctx: RequestContext, @Param('visitorId') visitorId: string, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const events = await this.connection.rawConnection.getRepository(VisitorEvent).find({
            where: { visitorId: String(visitorId).slice(0, 64) },
            order: { createdAt: 'ASC' },
            take: 1000,
        });
        return res.json({ visitorId, events });
    }

    /** Recent visitors — paginated via take + skip. */
    @Get('visitors/recent')
    async recent(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = clampInt((req.query as any).days, 7, 1, 365);
        const take = clampInt((req.query as any).take, 25, 1, 500);
        const skip = clampInt((req.query as any).skip, 0, 0, 1_000_000);
        const rows = await this.connection.rawConnection.query(
            `SELECT visitorId,
                    MAX(customerId)            AS customerId,
                    MIN(createdAt)             AS firstSeenAt,
                    MAX(createdAt)             AS lastSeenAt,
                    COUNT(DISTINCT sessionId)  AS sessions,
                    SUM(type='pageview')       AS pageviews,
                    MAX(country)               AS country,
                    MAX(city)                  AS city,
                    MAX(browser)               AS browser,
                    MAX(os)                    AS os,
                    MAX(device)                AS device
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY visitorId
             ORDER BY MAX(createdAt) DESC
             LIMIT ? OFFSET ?`,
            [days, take, skip],
        );
        const [{ total }] = await this.connection.rawConnection.query(
            `SELECT COUNT(DISTINCT visitorId) AS total
             FROM visitor_event WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [days],
        );
        return res.json({
            visitors: rows.map((r: any) => ({
                visitorId: r.visitorId,
                customerId: r.customerId,
                firstSeenAt: r.firstSeenAt,
                lastSeenAt: r.lastSeenAt,
                sessions: Number(r.sessions) || 0,
                pageviews: Number(r.pageviews) || 0,
                country: r.country,
                city: r.city,
                browser: r.browser,
                os: r.os,
                device: r.device,
            })),
            total: Number(total) || 0, take, skip,
        });
    }

    /** Full visitor profile — every available signal we have on this
     *  visitor, plus the most-recent IP / UA / location / locale,
     *  customer link, and per-session breakdown. Drives the clickable
     *  detail drawer in the admin UI. */
    @Get('visitors/profile/:visitorId')
    async profile(@Ctx() ctx: RequestContext, @Param('visitorId') visitorIdRaw: string, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const visitorId = String(visitorIdRaw).slice(0, 64);

        // One row with the latest non-null value of every column.
        const [latest] = await this.connection.rawConnection.query(
            `SELECT visitorId,
                    MAX(customerId)         AS customerId,
                    MIN(createdAt)          AS firstSeenAt,
                    MAX(createdAt)          AS lastSeenAt,
                    COUNT(DISTINCT sessionId) AS totalSessions,
                    SUM(type='pageview')    AS totalPageviews,
                    SUM(type='unload')      AS totalUnloads,
                    SUM(type='event')       AS totalEvents,
                    SUM(timeOnPageMs)       AS totalTimeMs,
                    MAX(ip)                 AS ip,
                    MAX(ipHash)             AS ipHash,
                    MAX(userAgent)          AS userAgent,
                    MAX(browser)            AS browser,
                    MAX(browserVersion)     AS browserVersion,
                    MAX(os)                 AS os,
                    MAX(osVersion)          AS osVersion,
                    MAX(device)             AS device,
                    MAX(acceptLanguage)     AS acceptLanguage,
                    MAX(country)            AS country,
                    MAX(region)             AS region,
                    MAX(city)               AS city,
                    MAX(timezone)           AS timezone,
                    MAX(channelId)          AS channelId
             FROM visitor_event
             WHERE visitorId = ?
             GROUP BY visitorId`,
            [visitorId],
        );
        if (!latest) return res.status(404).json({ error: 'visitor not found' });

        const sessions = await this.connection.rawConnection.query(
            `SELECT sessionId,
                    MIN(createdAt) AS startedAt,
                    MAX(createdAt) AS endedAt,
                    COUNT(*)       AS events,
                    SUM(type='pageview') AS pageviews,
                    SUM(timeOnPageMs)    AS timeMs,
                    MIN(CASE WHEN type='pageview' THEN url END) AS entryUrl
             FROM visitor_event
             WHERE visitorId = ?
             GROUP BY sessionId
             ORDER BY MIN(createdAt) DESC
             LIMIT 50`,
            [visitorId],
        );

        let customer: any = null;
        if (latest.customerId) {
            const [c] = await this.connection.rawConnection.query(
                `SELECT id, firstName, lastName, emailAddress
                 FROM customer WHERE id = ? LIMIT 1`,
                [Number(latest.customerId)],
            );
            customer = c || null;
        }

        return res.json({
            visitor: {
                visitorId: latest.visitorId,
                customerId: latest.customerId,
                customer,
                firstSeenAt: latest.firstSeenAt,
                lastSeenAt: latest.lastSeenAt,
                totals: {
                    sessions: Number(latest.totalSessions) || 0,
                    pageviews: Number(latest.totalPageviews) || 0,
                    unloads: Number(latest.totalUnloads) || 0,
                    events: Number(latest.totalEvents) || 0,
                    timeMs: Number(latest.totalTimeMs) || 0,
                },
                ip: latest.ip,
                ipHash: latest.ipHash,
                userAgent: latest.userAgent,
                browser: latest.browser,
                browserVersion: latest.browserVersion,
                os: latest.os,
                osVersion: latest.osVersion,
                device: latest.device,
                acceptLanguage: latest.acceptLanguage,
                country: latest.country,
                region: latest.region,
                city: latest.city,
                timezone: latest.timezone,
                channelId: latest.channelId,
            },
            sessions: sessions.map((s: any) => ({
                sessionId: s.sessionId,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                events: Number(s.events) || 0,
                pageviews: Number(s.pageviews) || 0,
                timeMs: Number(s.timeMs) || 0,
                entryUrl: s.entryUrl,
            })),
        });
    }

    // ------------------------------------------------------------------

    private applyCors(req: Request, res: Response) {
        const origin = String(req.headers.origin || '');
        // Allow the two storefronts + local dev. Anything else gets a
        // wildcard echo of the request origin so previews work without
        // needing config — we trust the request itself for ingest.
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }

    private parseCookies(req: Request): Record<string, string> {
        const raw = req.headers.cookie || '';
        const out: Record<string, string> = {};
        for (const part of raw.split(';')) {
            const idx = part.indexOf('=');
            if (idx < 0) continue;
            const k = part.slice(0, idx).trim();
            const v = decodeURIComponent(part.slice(idx + 1).trim());
            if (k) out[k] = v;
        }
        return out;
    }
}
