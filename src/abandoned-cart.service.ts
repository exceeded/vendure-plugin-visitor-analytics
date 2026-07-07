import { Injectable, Logger } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
import { createHash, randomBytes } from 'crypto';
import { AbandonedCart, AbandonedCartStatus } from './abandoned-cart.entity';
import { getOptions } from './plugin';

const loggerCtx = 'HuloAbandonedCartService';

/** Payload of a `cart_snapshot` custom event as posted by the storefront. */
export interface CartSnapshotMeta {
    currency?: string;
    totalMinor?: number;
    itemCount?: number;
    items?: Array<{
        variantId?: number | string;
        productId?: number | string;
        name?: string;
        qty?: number;
        unitPriceMinor?: number;
        sku?: string;
    }>;
    /** Optional — email captured at checkout step 1. */
    email?: string;
    countryCode?: string;
    /** Optional — city as reported by the storefront (from the
     *  shipping/billing address if the visitor has filled one). */
    city?: string;
}

/**
 * Config knobs. All optional; defaults tuned for the common case of a
 * B2C storefront with a ~15 min average checkout time. Set via
 * VisitorAnalyticsPluginOptions.abandonment.
 */
export interface AbandonmentOptions {
    /** Minutes since the last `cart_snapshot` before we mark a session
     *  as abandoned. Default 30 — long enough that a paused checkout
     *  isn't premature, short enough that recovery emails still feel
     *  timely. */
    windowMinutes?: number;
    /** Currency-minor threshold below which we don't emit a Slack
     *  notification. Prevents 3-figure inbox noise from every £5 cart
     *  drop-off. Default 5000 (£50 / $50). */
    slackMinValueMinor?: number;
    /** Slack webhook URL. When unset, notifications are logged only. */
    slackWebhookUrl?: string;
    /** Recovery-link HMAC secret. When unset, recovery-link generation
     *  returns null (feature disabled). Set this to something long and
     *  random. */
    recoveryLinkSecret?: string;
    /** Recovery-link TTL in hours. Default 72. */
    recoveryLinkTtlHours?: number;
    /** Storefront base URL — where the recovery link lands. Something
     *  like `https://shop.example.com`. Default: publicBaseUrl. */
    storefrontBaseUrl?: string;
}

@Injectable()
export class AbandonedCartService {
    constructor(private connection: TransactionalConnection) {}

    private opts(): Required<AbandonmentOptions> {
        const raw = (getOptions() as any).abandonment as AbandonmentOptions | undefined;
        return {
            windowMinutes: raw?.windowMinutes ?? 30,
            slackMinValueMinor: raw?.slackMinValueMinor ?? 5000,
            slackWebhookUrl: raw?.slackWebhookUrl ?? '',
            recoveryLinkSecret: raw?.recoveryLinkSecret ?? '',
            recoveryLinkTtlHours: raw?.recoveryLinkTtlHours ?? 72,
            storefrontBaseUrl: raw?.storefrontBaseUrl ?? getOptions().publicBaseUrl,
        };
    }

    /**
     * Full detection pass. Runs periodically (cron). Finds every session
     * that:
     *   1. Fired ≥1 `cart_snapshot` event
     *   2. Did NOT fire `checkout_completed` since
     *   3. Last snapshot is older than `windowMinutes`
     *   4. Not already covered by an `abandoned_cart` row with same sessionId
     *
     * Upserts a row per matched session. Marks any existing `abandoned`
     * row as `converted` when a matching `checkout_completed` is seen.
     * Fires the Slack notification for fresh rows above the threshold.
     */
    async scan(): Promise<{ opened: number; converted: number; slacked: number }> {
        const o = this.opts();
        const conn = this.connection.rawConnection;
        const cutoff = new Date(Date.now() - o.windowMinutes * 60_000);
        // 1. Auto-mark existing abandoned rows as converted when a
        //    matching checkout_completed lands afterwards.
        const converted = await conn.query(
            `UPDATE abandoned_cart ac
             SET ac.status = 'converted', ac.recoveredAt = NOW()
             WHERE ac.status = 'abandoned'
               AND EXISTS (
                 SELECT 1 FROM visitor_event ve
                 WHERE ve.sessionId = ac.sessionId
                   AND ve.type = 'event'
                   AND ve.meta LIKE '%"eventType":"checkout_completed"%'
                   AND ve.createdAt > ac.abandonedAt
               )`,
        );
        const convertedCount = Number(converted?.affectedRows ?? converted?.[1] ?? 0);
        // 2. Find candidate sessions.
        // Sub-select the session-level aggregates first (visitor_event
        // is the largest table on any active install), then LEFT JOIN
        // `customer` for a name/phone snapshot. That way the customer
        // lookup runs once per candidate, not once per row.
        const candidates: any[] = await conn.query(
            `SELECT
                agg.*,
                c.firstName    AS custFirstName,
                c.lastName     AS custLastName,
                c.phoneNumber  AS custPhone
             FROM (SELECT
                ve.sessionId,
                MAX(ve.visitorId) AS visitorId,
                MAX(ve.customerId) AS customerId,
                MAX(ve.channelId) AS channelId,
                MIN(ve.createdAt) AS firstAt,
                MAX(ve.createdAt) AS lastAt,
                -- Landing URL: the earliest URL in the session (window-fn
                -- would be cleaner but MariaDB 10.2+ has FIRST_VALUE via
                -- SUBSTRING_INDEX(GROUP_CONCAT()) — same trick we use for
                -- lastMeta below).
                SUBSTRING_INDEX(GROUP_CONCAT(ve.url ORDER BY ve.createdAt ASC SEPARATOR ''), '', 1) AS firstUrl,
                MAX(ve.url) AS lastUrl,
                SUBSTRING_INDEX(GROUP_CONCAT(ve.referrer ORDER BY ve.createdAt ASC SEPARATOR ''), '', 1) AS firstReferrer,
                MAX(ve.referrer) AS lastReferrer,
                MAX(ve.utmSource) AS utmSource,
                MAX(ve.utmMedium) AS utmMedium,
                MAX(ve.utmCampaign) AS utmCampaign,
                MAX(ve.country) AS countryCode,
                MAX(ve.region) AS regionCode,
                MAX(ve.ip) AS ip,
                MAX(ve.ipHash) AS ipHash,
                MAX(ve.userAgent) AS userAgent,
                MAX(ve.browser) AS browser,
                -- Total pageview events in the same session — cheap
                -- "high-intent vs quick-bounce" facet in the admin.
                SUM(CASE WHEN ve.type = 'pageview' THEN 1 ELSE 0 END) AS pageViews,
                SUBSTRING_INDEX(GROUP_CONCAT(ve.meta ORDER BY ve.createdAt DESC SEPARATOR '¦'), '¦', 1) AS lastMeta
             FROM visitor_event ve
             WHERE ve.sessionId IN (
                 SELECT DISTINCT ve0.sessionId
                 FROM visitor_event ve0
                 WHERE ve0.type = 'event'
                   AND ve0.meta LIKE '%"eventType":"cart_snapshot"%'
                   AND ve0.createdAt >= (NOW() - INTERVAL 48 HOUR)
                   AND ve0.createdAt <= ?
             )
               AND NOT EXISTS (
                 SELECT 1 FROM visitor_event ve2
                 WHERE ve2.sessionId = ve.sessionId
                   AND ve2.type = 'event'
                   AND ve2.meta LIKE '%"eventType":"checkout_completed"%'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM visitor_event ve3
                 WHERE ve3.sessionId = ve.sessionId
                   AND ve3.type = 'event'
                   AND ve3.meta LIKE '%"eventType":"cart_snapshot"%'
                   AND ve3.createdAt > ?
               )
             GROUP BY ve.sessionId
             LIMIT 500) agg
             LEFT JOIN customer c ON c.id = agg.customerId AND c.deletedAt IS NULL`,
            [cutoff, cutoff],
        );

        let opened = 0;
        let slacked = 0;
        for (const c of candidates) {
            const meta = this.parseMeta(c.lastMeta);
            if (!meta) continue;
            const totalMinor = Number(meta.totalMinor || 0);
            const itemCount = Number(meta.itemCount ?? meta.items?.length ?? 0);
            if (!itemCount) continue; // empty cart isn't abandonment
            const items = Array.isArray(meta.items) ? meta.items : [];
            const email = (meta.email || '').trim().toLowerCase() || null;
            const emailHash = email ? createHash('sha256').update(email).digest('hex') : null;

            const existing: any[] = await conn.query(
                `SELECT id, status, notificationSent FROM abandoned_cart WHERE sessionId = ? LIMIT 1`,
                [c.sessionId],
            );
            // Dwell = last activity − first activity, in seconds.
            // Denormalised so admin filters + sorting don't need to
            // recompute on every read.
            const firstAt = new Date(c.firstAt);
            const lastAt = new Date(c.lastAt);
            const dwellSeconds = Math.max(0, Math.round((lastAt.getTime() - firstAt.getTime()) / 1000));
            const deviceType = classifyDevice(c.userAgent);

            if (existing?.length) {
                // Refresh in place — but never resurrect a converted/dismissed row.
                if (existing[0].status !== 'abandoned') continue;
                await conn.query(
                    `UPDATE abandoned_cart SET
                        totalMinor = ?, itemCount = ?, itemsJson = ?,
                        email = COALESCE(?, email),
                        emailHash = COALESCE(?, emailHash),
                        lastSnapshotAt = ?, lastKnownUrl = ?,
                        countryCode = COALESCE(?, countryCode),
                        regionCode = COALESCE(?, regionCode),
                        ip = COALESCE(?, ip),
                        ipHash = COALESCE(?, ipHash),
                        userAgent = COALESCE(?, userAgent),
                        browser = COALESCE(?, browser),
                        deviceType = COALESCE(?, deviceType),
                        pageViews = ?,
                        dwellSeconds = ?,
                        firstName = COALESCE(?, firstName),
                        lastName = COALESCE(?, lastName),
                        phone = COALESCE(?, phone),
                        updatedAt = NOW(3)
                     WHERE id = ?`,
                    [
                        totalMinor, itemCount, JSON.stringify(items),
                        email, emailHash,
                        lastAt, c.lastUrl,
                        meta.countryCode || c.countryCode,
                        c.regionCode,
                        c.ip, c.ipHash,
                        c.userAgent, c.browser, deviceType,
                        Number(c.pageViews || 0) || null,
                        dwellSeconds,
                        c.custFirstName || null, c.custLastName || null, c.custPhone || null,
                        existing[0].id,
                    ],
                );
                continue;
            }

            await conn.query(
                `INSERT INTO abandoned_cart (
                    visitorId, sessionId, customerId, channelId,
                    currency, totalMinor, itemCount, itemsJson,
                    email, emailHash,
                    firstSnapshotAt, lastSnapshotAt, abandonedAt,
                    status, lastKnownUrl, lastKnownReferrer, landingUrl,
                    utmSource, utmMedium, utmCampaign, countryCode,
                    regionCode, city, ip, ipHash,
                    userAgent, browser, deviceType,
                    pageViews, dwellSeconds,
                    firstName, lastName, phone,
                    notificationSent, createdAt, updatedAt
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), 'abandoned',
                           ?, ?, ?, ?, ?, ?, ?,
                           ?, ?, ?, ?,
                           ?, ?, ?,
                           ?, ?,
                           ?, ?, ?,
                           0, NOW(3), NOW(3))`,
                [
                    c.visitorId, c.sessionId, c.customerId, c.channelId || 1,
                    (meta.currency || 'GBP').slice(0, 3), totalMinor, itemCount, JSON.stringify(items),
                    email, emailHash,
                    firstAt, lastAt,
                    c.lastUrl, c.lastReferrer, c.firstUrl,
                    c.utmSource, c.utmMedium, c.utmCampaign, meta.countryCode || c.countryCode,
                    c.regionCode, meta.city || null, c.ip, c.ipHash,
                    c.userAgent, c.browser, deviceType,
                    Number(c.pageViews || 0) || null, dwellSeconds,
                    c.custFirstName || null, c.custLastName || null, c.custPhone || null,
                ],
            );
            opened += 1;

            if (totalMinor >= o.slackMinValueMinor && o.slackWebhookUrl) {
                try {
                    await this.postSlack(o.slackWebhookUrl, {
                        totalMinor, itemCount, items, email,
                        countryCode: meta.countryCode || c.countryCode,
                        lastUrl: c.lastUrl,
                        currency: (meta.currency || 'GBP').slice(0, 3),
                    });
                    await conn.query(
                        `UPDATE abandoned_cart SET notificationSent = 1 WHERE sessionId = ?`,
                        [c.sessionId],
                    );
                    slacked += 1;
                } catch (e: any) {
                    Logger.warn(`Slack notify failed for session=${c.sessionId}: ${e?.message}`, loggerCtx);
                }
            }
        }
        if (opened || convertedCount) {
            Logger.log(
                `Abandonment scan: +${opened} opened / +${convertedCount} converted / ${slacked} slacked`,
                loggerCtx,
            );
        }
        return { opened, converted: convertedCount, slacked };
    }

    /**
     * Generate a signed recovery link that the storefront can decode to
     * restore the cart. Returns null when the recovery-link secret is
     * unset (feature disabled). Idempotent: reissues a fresh token so
     * you can safely regenerate before every send.
     */
    async issueRecoveryLink(cartId: number): Promise<string | null> {
        const o = this.opts();
        if (!o.recoveryLinkSecret) return null;
        const conn = this.connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT sessionId, visitorId FROM abandoned_cart WHERE id = ? LIMIT 1`,
            [cartId],
        );
        if (!rows?.length) return null;
        const token = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + o.recoveryLinkTtlHours * 3600_000);
        await conn.query(
            `UPDATE abandoned_cart SET recoveryToken = ?, recoveryTokenExpiresAt = ? WHERE id = ?`,
            [token, expiresAt, cartId],
        );
        const base = (o.storefrontBaseUrl || '').replace(/\/$/, '');
        return `${base}/cart/restore?t=${token}`;
    }

    /**
     * Look up an abandoned cart by its recovery token. Returns null if
     * the token is unknown, expired, or the cart is already recovered.
     * Storefront calls this via `/ees/recover-cart?t=...` to rebuild the
     * cart from the persisted itemsJson.
     */
    async findByRecoveryToken(token: string): Promise<{
        id: number;
        currency: string;
        items: any[];
        email: string | null;
    } | null> {
        const conn = this.connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT id, currency, itemsJson, email, recoveryTokenExpiresAt, status
             FROM abandoned_cart WHERE recoveryToken = ? LIMIT 1`,
            [token],
        );
        if (!rows?.length) return null;
        const r = rows[0];
        if (r.status === 'expired' || r.status === 'converted') return null;
        if (r.recoveryTokenExpiresAt && new Date(r.recoveryTokenExpiresAt).getTime() < Date.now()) {
            await conn.query(
                `UPDATE abandoned_cart SET status = 'expired' WHERE id = ?`,
                [r.id],
            );
            return null;
        }
        let items: any[] = [];
        try { items = JSON.parse(r.itemsJson || '[]'); } catch {}
        return { id: Number(r.id), currency: String(r.currency || 'GBP'), items, email: r.email };
    }

    async markStatus(cartId: number, status: AbandonedCartStatus): Promise<boolean> {
        const conn = this.connection.rawConnection;
        const setRecovered = status === 'recovered' ? ', recoveredAt = NOW(3)' : '';
        const res = await conn.query(
            `UPDATE abandoned_cart SET status = ? ${setRecovered} WHERE id = ?`,
            [status, cartId],
        );
        return Number(res?.affectedRows ?? 0) > 0;
    }

    // ── helpers ─────────────────────────────────────────────────────

    private parseMeta(raw: string | null): CartSnapshotMeta | null {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            // Custom-event rows have `{ eventType, ... }` — the payload
            // is the rest of the object.
            return parsed as CartSnapshotMeta;
        } catch {
            return null;
        }
    }

    private async postSlack(url: string, payload: {
        totalMinor: number;
        currency: string;
        itemCount: number;
        items: any[];
        email: string | null;
        countryCode?: string | null;
        lastUrl?: string | null;
    }): Promise<void> {
        const money = this.formatMoney(payload.totalMinor, payload.currency);
        const itemList = payload.items.slice(0, 5)
            .map(i => `• ${i.qty ?? 1}× ${i.name ?? '(unnamed item)'}`)
            .join('\n');
        const more = payload.items.length > 5 ? `\n_…and ${payload.items.length - 5} more_` : '';
        const parts = [
            `🛒 *Abandoned cart* — ${money} · ${payload.itemCount} item${payload.itemCount === 1 ? '' : 's'}`,
            payload.email ? `Contact: \`${payload.email}\`` : '_(no email captured)_',
            payload.countryCode ? `Country: ${payload.countryCode}` : '',
            payload.lastUrl ? `Last URL: ${payload.lastUrl}` : '',
            itemList + more,
        ].filter(Boolean);
        await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: parts.join('\n') }),
        });
    }

    private formatMoney(minor: number, currency: string): string {
        const major = (minor || 0) / 100;
        try {
            return new Intl.NumberFormat('en-GB', {
                style: 'currency', currency,
            }).format(major);
        } catch {
            return `${currency} ${major.toFixed(2)}`;
        }
    }
}

/**
 * Tiny UA classifier — mobile / tablet / bot / desktop. Same
 * heuristics the visitor_event scanner uses so the two tables
 * agree on device buckets.
 */
function classifyDevice(ua: string | null | undefined): string | null {
    const s = String(ua || '').toLowerCase();
    if (!s) return null;
    if (/bot|crawl|spider|slurp|scanner/.test(s)) return 'bot';
    if (/ipad|tablet|kindle|playbook/.test(s)) return 'tablet';
    if (/mobile|iphone|android(?!.*tablet)|windows phone/.test(s)) return 'mobile';
    return 'desktop';
}
