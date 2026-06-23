import { Body, Controller, Delete, Get, OnApplicationBootstrap, OnModuleDestroy, Param, Post, Put, Req, Res } from '@nestjs/common';
import {
    applySecurityHeaders,
    isLicensed,
    premiumFeatureError,
    RateLimiter,
    signValue,
    startRetentionSweeper,
    verifySignedValue,
} from '@huloglobal/vendure-licence-sdk';
import { Ctx, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import { Request, Response } from 'express';
import { ConversionGoal } from './conversion-goal.entity';
import { VisitorAnalyticsPlugin, getOptions } from './plugin';
import { VisitorEvent } from './visitor-event.entity';
import { VisitorTrackingService } from './visitor-tracking.service';

const COOKIE_VISITOR = 'ees_vid';
const COOKIE_SESSION = 'ees_sid';
const VISITOR_TTL_DAYS = 730;   // ~2 years
const SESSION_IDLE_MIN = 30;    // 30-minute idle session timeout

/** Free-tier daily event cap. 100 / UTC day across the whole install
 *  — enough to evaluate, not enough to run a real store on. The
 *  counter is in-memory only (acceptable: free-tier installs aren't
 *  multi-instance anyway, and resetting on restart works in the
 *  customer's favour). */
const FREE_TIER_DAILY_CAP = 100;
const freeTierBudget = (() => {
    let day = '';
    let used = 0;
    return {
        consume(n: number): boolean {
            const today = new Date().toISOString().slice(0, 10);
            if (today !== day) { day = today; used = 0; }
            if (used + n > FREE_TIER_DAILY_CAP) return false;
            used += n;
            return true;
        },
        snapshot(): { day: string; used: number; cap: number } {
            const today = new Date().toISOString().slice(0, 10);
            if (today !== day) return { day: today, used: 0, cap: FREE_TIER_DAILY_CAP };
            return { day, used, cap: FREE_TIER_DAILY_CAP };
        },
    };
})();

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
export class VisitorTrackingController implements OnApplicationBootstrap, OnModuleDestroy {
    private limiter: RateLimiter | null = null;
    private stopRetention: (() => void) | null = null;

    constructor(
        private connection: TransactionalConnection,
        private tracking: VisitorTrackingService,
    ) {}

    onApplicationBootstrap(): void {
        const opts = getOptions();
        const rl = opts.rateLimit || { capacity: 240, windowMs: 60_000 };
        this.limiter = new RateLimiter({ capacity: rl.capacity, windowMs: rl.windowMs });
        if (opts.retention) {
            this.stopRetention = startRetentionSweeper({
                getConnection: () => this.connection.rawConnection,
                table: 'visitor_event',
                options: opts.retention,
                label: 'visitor-analytics',
            });
        }
    }

    onModuleDestroy(): void {
        this.stopRetention?.();
        this.stopRetention = null;
    }

    private rateLimited(req: Request, res: Response, bucket: string): boolean {
        const ip = (req.headers['cf-connecting-ip'] as string) || req.ip || '';
        if (!ip || !this.limiter) return false;
        if (!this.limiter.allow(`${bucket}|${ip}`)) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ stored: 0, skipped: 'rate-limited' });
            return true;
        }
        return false;
    }

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
        applySecurityHeaders(res);
        if (req.method === 'OPTIONS') return res.status(204).end();

        if (this.rateLimited(req, res, 'track')) return;

        // Tier-gate: unlicensed installs are capped at 100 events / UTC day.
        // Once the cap is hit, /track returns 200 with `skipped: 'free-tier-cap'`
        // so the storefront's beacon doesn't surface errors to end users.
        if (!isLicensed(VisitorAnalyticsPlugin.getLicenceStatus())) {
            const eventsLen = Array.isArray((body || {}).events) ? body.events.length : 1;
            if (!freeTierBudget.consume(eventsLen)) {
                return res.json({ stored: 0, skipped: 'free-tier-cap', cap: FREE_TIER_DAILY_CAP });
            }
        }

        const opts = getOptions();

        // Privacy: honour Do-Not-Track when configured. We still return 200
        // so the storefront can't tell the difference between "stored" and
        // "skipped" — keeps the wire shape stable.
        if (opts.honorDoNotTrack) {
            const dnt = String(req.headers['dnt'] || req.headers['sec-gpc'] || '').trim();
            if (dnt === '1') {
                return res.json({ stored: 0, skipped: 'dnt' });
            }
        }

        const cookies = this.parseCookies(req);

        // Privacy: optional consent gate.
        if (opts.requireConsent) {
            const consented = body?.consent === true || cookies['ees_consent'] === '1';
            if (!consented) {
                return res.json({ stored: 0, skipped: 'no-consent' });
            }
        }

        // Read + verify the cookies. When a signingSecret is configured,
        // we expect each cookie to be `<id>.<hmac>` and reject tampered
        // values. Without a secret, we accept bare ids (legacy).
        let visitorId = this.readSignedCookie(cookies[COOKIE_VISITOR], opts.signingSecret);
        let sessionId = this.readSignedCookie(cookies[COOKIE_SESSION], opts.signingSecret);
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
        // Set Secure when serving over HTTPS (Cloudflare forwards a hint).
        const secureFlag = (req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-visitor']?.includes('https'))
            ? '; Secure' : '';
        const cookieOpts = (maxAgeSec: number) => `Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secureFlag}`;
        const vidCookie = opts.signingSecret ? signValue(visitorId, opts.signingSecret) : visitorId;
        const sidCookie = opts.signingSecret ? signValue(sessionId, opts.signingSecret) : sessionId;
        res.setHeader('Set-Cookie', [
            `${COOKIE_VISITOR}=${vidCookie}; ${cookieOpts(VISITOR_TTL_DAYS * 86400)}`,
            `${COOKIE_SESSION}=${sidCookie}; ${cookieOpts(SESSION_IDLE_MIN * 60)}`,
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
        if (!isLicensed(VisitorAnalyticsPlugin.getLicenceStatus())) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-visitor-analytics'));
        }

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
        const allowList = getOptions().corsAllowedOrigins || [];
        // When an allowlist is configured we reflect only matching
        // origins; otherwise we reflect any (legacy behaviour, looser).
        let allow = origin || '*';
        if (allowList.length) {
            allow = allowList.includes(origin) ? origin : 'null';
        }
        res.setHeader('Access-Control-Allow-Origin', allow);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }

    /** Read a possibly-signed cookie. When `secret` is provided we
     *  require + verify the signature; otherwise we return the raw
     *  value. Returns empty string for missing / tampered values. */
    private readSignedCookie(raw: string | undefined, secret: string | undefined): string {
        const value = String(raw || '').slice(0, 256);
        if (!value) return '';
        if (!secret) return value;
        const verified = verifySignedValue(value, secret);
        return verified || '';
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

    /** Admin: plugin health + update availability. Read by the admin UI
     * banner so the operator sees when a new version is on npm. */
    @Get('visitors/status')
    async status(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const updater = VisitorAnalyticsPlugin.getUpdateChecker();
        const update = updater ? updater.getStatus() : null;
        return res.json({
            packageName: VisitorAnalyticsPlugin.getPackageName(),
            version: VisitorAnalyticsPlugin.getPackageVersion(),
            update,
            uptimeSec: Math.round(process.uptime()),
        });
    }

    // ── Conversion goals ────────────────────────────────────────────────

    /** Admin: list goals for a channel. */
    @Get('goals')
    async listGoals(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const channelId = parseInt(String((req.query as any).channelId || '1'), 10) || 1;
        const repo = this.connection.rawConnection.getRepository(ConversionGoal);
        const rows = await repo.find({ where: { channelId }, order: { id: 'ASC' } });
        return res.json({ goals: rows });
    }

    /** Admin: create a goal. */
    @Post('goals')
    async createGoal(@Ctx() ctx: RequestContext, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        if (!isLicensed(VisitorAnalyticsPlugin.getLicenceStatus())) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-visitor-analytics'));
        }
        const repo = this.connection.rawConnection.getRepository(ConversionGoal);
        const row = repo.create({
            channelId: Number(body?.channelId) || 1,
            name: String(body?.name || '').slice(0, 128).trim(),
            urlPattern: String(body?.urlPattern || '').slice(0, 256).trim(),
            valueMinor: Math.max(0, parseInt(body?.valueMinor, 10) || 0),
            enabled: body?.enabled !== false,
        });
        if (!row.name || !row.urlPattern) {
            return res.status(400).json({ error: 'name and urlPattern required' });
        }
        const saved = await repo.save(row);
        this.tracking.invalidateGoalCache();
        return res.json({ goal: saved });
    }

    /** Admin: update a goal. */
    @Put('goals/:id')
    async updateGoal(@Ctx() ctx: RequestContext, @Param('id') idParam: string, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const id = parseInt(idParam, 10);
        const repo = this.connection.rawConnection.getRepository(ConversionGoal);
        const row = await repo.findOne({ where: { id } });
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (typeof body?.name === 'string') row.name = body.name.slice(0, 128);
        if (typeof body?.urlPattern === 'string') row.urlPattern = body.urlPattern.slice(0, 256);
        if (typeof body?.valueMinor === 'number') row.valueMinor = Math.max(0, body.valueMinor);
        if (typeof body?.enabled === 'boolean') row.enabled = body.enabled;
        const saved = await repo.save(row);
        this.tracking.invalidateGoalCache();
        return res.json({ goal: saved });
    }

    /** Admin: delete a goal. */
    @Delete('goals/:id')
    async deleteGoal(@Ctx() ctx: RequestContext, @Param('id') idParam: string, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const id = parseInt(idParam, 10);
        const repo = this.connection.rawConnection.getRepository(ConversionGoal);
        const result = await repo.delete({ id });
        this.tracking.invalidateGoalCache();
        return res.json({ ok: !!(result.affected && result.affected > 0) });
    }

    /** Admin: per-goal stats over the last N days (default 30). */
    @Get('goals/stats')
    async goalsStats(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        const days = Math.min(Math.max(parseInt(String((req.query as any).days || '30'), 10) || 30, 1), 365);
        const channelId = parseInt(String((req.query as any).channelId || '1'), 10) || 1;
        const rows = await this.connection.rawConnection.query(
            `SELECT g.id, g.name, g.urlPattern, g.valueMinor, g.enabled,
                    COUNT(DISTINCT v.visitorId) AS uniqueVisitors,
                    COUNT(*) AS completions
             FROM conversion_goal g
             LEFT JOIN visitor_event v
                ON v.goalId = g.id
               AND v.createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND v.isBot = 0
             WHERE g.channelId = ?
             GROUP BY g.id`,
            [days, channelId],
        );
        return res.json({ days, channelId, goals: rows.map((r: any) => ({
            ...r,
            valueMinor: Number(r.valueMinor) * Number(r.completions || 0),
        })) });
    }

    /** Admin: CSV export of recent visitor events with all enrichment. */
    @Get('visitors/export.csv')
    async exportCsv(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res)) return;
        if (!isLicensed(VisitorAnalyticsPlugin.getLicenceStatus())) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-visitor-analytics'));
        }
        const days = Math.min(Math.max(parseInt(String((req.query as any).days || '7'), 10) || 7, 1), 90);
        const rows = await this.connection.rawConnection.query(
            `SELECT createdAt, visitorId, sessionId, customerId, channelId,
                    type, url, title, referrerDomain,
                    country, region, city, browser, os, device,
                    isBot, goalId, utmSource, utmMedium, utmCampaign
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
             ORDER BY createdAt DESC
             LIMIT 200000`,
            [days],
        );
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="visitors-${new Date().toISOString().slice(0, 10)}.csv"`);
        const esc = (v: any): string => {
            if (v === null || v === undefined) return '';
            const s = String(v).replace(/"/g, '""');
            return /[",\n]/.test(s) ? `"${s}"` : s;
        };
        res.write('createdAt,visitorId,sessionId,customerId,channelId,type,url,title,referrerDomain,country,region,city,browser,os,device,isBot,goalId,utmSource,utmMedium,utmCampaign\n');
        for (const r of rows) {
            res.write([
                esc(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
                esc(r.visitorId), esc(r.sessionId), esc(r.customerId), esc(r.channelId),
                esc(r.type), esc(r.url), esc(r.title), esc(r.referrerDomain),
                esc(r.country), esc(r.region), esc(r.city), esc(r.browser), esc(r.os), esc(r.device),
                esc(r.isBot), esc(r.goalId),
                esc(r.utmSource), esc(r.utmMedium), esc(r.utmCampaign),
            ].join(',') + '\n');
        }
        return res.end();
    }
}
