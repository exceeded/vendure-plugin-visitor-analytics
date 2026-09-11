import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
import { createHash, randomBytes } from 'crypto';
import { AbandonedCart, AbandonedCartStatus } from './abandoned-cart.entity';
import { getOptions } from './plugin';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import {
    advanceRecoveryStep,
    buildListUnsubscribeHeaders,
    buildOptOutUrl,
    hashEmail,
    isResumableOrderState,
    normaliseEmail,
    sanitiseOrderCode,
} from './recovery-tokens';

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
    /** Per-channel storefront base URLs, keyed by channel code, for
     *  multi-storefront installs — a cart abandoned on channel
     *  `licensedock` gets a link to that storefront. Falls back to
     *  `storefrontBaseUrl` for channels not listed. */
    storefrontBaseUrls?: Record<string, string>;
    /** HMAC secret for the email opt-out links
     *  (`GET|POST /ees/abandoned-carts/opt-out?e=…`). Defaults to
     *  `recoveryLinkSecret`, then the plugin-level `signingSecret`. When
     *  none of the three is set, opt-out links cannot be built and the
     *  endpoint rejects every token. */
    optOutSecret?: string;
}

/** Options for `issueRecoveryLink`. */
export interface IssueRecoveryLinkOptions {
    /** Bind the link to a specific open Vendure order (its `code`). The
     *  storefront can then resume that order — via
     *  `POST /ees/recover-cart/resume` — instead of rebuilding a cart, as
     *  long as the order is still in `AddingItems` / `ArrangingPayment`. */
    resumeOrderCode?: string | null;
}

/** What `findByRecoveryToken` hands the storefront. */
export interface RecoveredCart {
    id: number;
    currency: string;
    items: any[];
    email: string | null;
    /** Order code the link was bound to at issue time, if any. */
    orderCode: string | null;
    /** Live state of that order (null when unbound or the order is gone). */
    orderState: string | null;
    /** True when `orderCode` is set and the order can still be picked up. */
    resumable: boolean;
    channelId: number;
}

/** Result of `resumeByRecoveryToken`. */
export interface ResumedCart extends RecoveredCart {
    /** Present only when the bound order is still open — the storefront
     *  should use it; otherwise fall back to re-adding `items`. */
    resumeOrderCode: string | null;
}

interface OrderRow { id: number; code: string; state: string; channelId: number | null }

@Injectable()
export class AbandonedCartService implements OnApplicationBootstrap {
    constructor(private connection: TransactionalConnection) {}

    /** Add the 0.18.0 columns + the opt-out table on installs that don't
     *  run TypeORM migrations for plugins. Idempotent; never blocks boot. */
    async onApplicationBootstrap(): Promise<void> {
        try {
            await this.ensureSchema();
        } catch (e: any) {
            Logger.warn(`Schema check failed (will retry next boot): ${e?.message}`, loggerCtx);
        }
    }

    async ensureSchema(): Promise<void> {
        const conn = adapterFor(this.connection.rawConnection);
        const cols: Array<[string, string]> = [
            ['resumeOrderCode', 'VARCHAR(32) NULL'],
            ['recoveryStep', 'VARCHAR(16) NULL'],
            ['convertedAt', 'DATETIME(3) NULL'],
            ['convertedOrderId', 'INT NULL'],
            ['convertedOrderCode', 'VARCHAR(32) NULL'],
        ];
        for (const [name, type] of cols) {
            await conn.query(`ALTER TABLE abandoned_cart ADD COLUMN IF NOT EXISTS ${name} ${type}`);
        }
        await conn.query(`
            CREATE TABLE IF NOT EXISTS abandoned_cart_opt_out (
                id INT AUTO_INCREMENT PRIMARY KEY,
                emailHash VARCHAR(64) NOT NULL,
                email VARCHAR(255) NOT NULL,
                channelId INT NULL,
                source VARCHAR(32) NOT NULL DEFAULT 'link',
                ip VARCHAR(45) NULL,
                createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                UNIQUE INDEX abandoned_cart_opt_out_hash_uniq (emailHash)
            )
        `);
    }

    private opts(): Required<AbandonmentOptions> {
        const raw = (getOptions() as any).abandonment as AbandonmentOptions | undefined;
        return {
            windowMinutes: raw?.windowMinutes ?? 30,
            slackMinValueMinor: raw?.slackMinValueMinor ?? 5000,
            slackWebhookUrl: raw?.slackWebhookUrl ?? '',
            recoveryLinkSecret: raw?.recoveryLinkSecret ?? '',
            recoveryLinkTtlHours: raw?.recoveryLinkTtlHours ?? 72,
            storefrontBaseUrl: raw?.storefrontBaseUrl ?? getOptions().publicBaseUrl,
            storefrontBaseUrls: raw?.storefrontBaseUrls ?? {},
            optOutSecret: raw?.optOutSecret ?? raw?.recoveryLinkSecret ?? (getOptions() as any).signingSecret ?? '',
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
        const conn = adapterFor(this.connection.rawConnection);
        const cutoff = new Date(Date.now() - o.windowMinutes * 60_000);
        // 1. Auto-mark existing abandoned rows as converted when a
        //    matching checkout_completed lands afterwards.
        const converted = await conn.query(
            `UPDATE abandoned_cart ac
             SET ac.status = 'converted', ac.recoveredAt = NOW(), ac.convertedAt = COALESCE(ac.convertedAt, NOW())
             WHERE ac.status = 'abandoned'
               AND EXISTS (
                 SELECT 1 FROM visitor_event ve
                 WHERE ve.sessionId = ac.sessionId
                   AND ve.type = 'event'
                   AND ve.meta LIKE '%"eventType":"checkout_completed"%'
                   AND ve.createdAt > ac.abandonedAt
               )`,
            undefined,
            { needAffected: true },
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
     *
     * Pass `{ resumeOrderCode }` to bind the link to the visitor's open
     * Vendure order: `findByRecoveryToken` / the resume endpoint then
     * return that code (while the order is still `AddingItems` /
     * `ArrangingPayment`) so the storefront can pick up the same order
     * instead of rebuilding it. Passing `{ resumeOrderCode: null }`
     * clears a previous binding; omitting the option keeps it.
     *
     * Also advances `recoveryStep` to `link_issued`.
     */
    async issueRecoveryLink(cartId: number, options: IssueRecoveryLinkOptions = {}): Promise<string | null> {
        const o = this.opts();
        if (!o.recoveryLinkSecret) return null;
        const conn = adapterFor(this.connection.rawConnection);
        const rows: any[] = await conn.query(
            `SELECT ac.sessionId, ac.visitorId, ac.channelId, ac.recoveryStep, ch.code AS channelCode
             FROM abandoned_cart ac LEFT JOIN channel ch ON ch.id = ac.channelId
             WHERE ac.id = ? LIMIT 1`,
            [cartId],
        );
        if (!rows?.length) return null;
        const token = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + o.recoveryLinkTtlHours * 3600_000);
        const step = advanceRecoveryStep(rows[0].recoveryStep, 'link_issued');
        if (options.resumeOrderCode !== undefined) {
            const code = options.resumeOrderCode === null ? null : sanitiseOrderCode(options.resumeOrderCode) || null;
            await conn.query(
                `UPDATE abandoned_cart
                 SET recoveryToken = ?, recoveryTokenExpiresAt = ?, resumeOrderCode = ?, recoveryStep = ?
                 WHERE id = ?`,
                [token, expiresAt, code, step, cartId],
            );
        } else {
            await conn.query(
                `UPDATE abandoned_cart SET recoveryToken = ?, recoveryTokenExpiresAt = ?, recoveryStep = ? WHERE id = ?`,
                [token, expiresAt, step, cartId],
            );
        }
        return `${this.storefrontBaseFor(rows[0].channelCode)}/cart/restore?t=${token}`;
    }

    /** Storefront origin for a channel: the per-channel map first, then
     *  the single storefrontBaseUrl. Trailing slashes are dropped. */
    storefrontBaseFor(channelCode?: string | null): string {
        const o = this.opts();
        const perChannel = channelCode ? o.storefrontBaseUrls?.[channelCode] : undefined;
        return String(perChannel || o.storefrontBaseUrl || '').replace(/\/$/, '');
    }

    /**
     * Look up an abandoned cart by its recovery token. Returns null if
     * the token is unknown, expired, or the cart is already recovered.
     * Storefront calls this via `/ees/recover-cart?t=...` to rebuild the
     * cart from the persisted itemsJson.
     *
     * Since 0.18.0 the result also carries `orderCode` / `orderState` /
     * `resumable` when the link was bound to an order, and the call
     * advances `recoveryStep` to `link_opened`.
     */
    async findByRecoveryToken(token: string): Promise<RecoveredCart | null> {
        const conn = adapterFor(this.connection.rawConnection);
        const t = String(token || '').trim();
        if (!t || t.length > 128) return null;
        const rows: any[] = await conn.query(
            `SELECT id, currency, itemsJson, email, recoveryTokenExpiresAt, status, resumeOrderCode, recoveryStep, channelId
             FROM abandoned_cart WHERE recoveryToken = ? LIMIT 1`,
            [t],
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
        const step = advanceRecoveryStep(r.recoveryStep, 'link_opened');
        if (step !== r.recoveryStep) {
            await conn.query(`UPDATE abandoned_cart SET recoveryStep = ? WHERE id = ?`, [step, r.id]);
        }
        return this.buildRecoveredCart(r);
    }

    /**
     * Token-bound "resume" — the storefront calls this (via
     * `POST /ees/recover-cart/resume?t=…`) when it would rather pick up
     * the exact order the visitor left than rebuild a cart. Returns the
     * same payload as `findByRecoveryToken` plus `resumeOrderCode`, which
     * is set only while the bound order is still open. Advances
     * `recoveryStep` to `resumed` (only when there is an order to resume,
     * so the funnel column stays honest).
     */
    async resumeByRecoveryToken(token: string): Promise<ResumedCart | null> {
        const cart = await this.findByRecoveryToken(token);
        if (!cart) return null;
        const resumeOrderCode = cart.resumable ? cart.orderCode : null;
        if (resumeOrderCode) {
            const conn = adapterFor(this.connection.rawConnection);
            await conn.query(
                `UPDATE abandoned_cart SET recoveryStep = ? WHERE id = ? AND (recoveryStep IS NULL OR recoveryStep IN ('link_issued','link_opened'))`,
                ['resumed', cart.id],
            );
        }
        return { ...cart, resumeOrderCode };
    }

    /**
     * Attribution: the restored cart checked out. Called by the storefront
     * (`POST /ees/recover-cart/converted { t, orderCode }`) from the
     * confirmation page. Token-bound so nobody can mark a stranger's cart
     * converted; the order must exist and be past `AddingItems`.
     *
     * Deliberately ignores token expiry and the row's status — a visitor
     * who opens the link at hour 71 and pays at hour 73 still converted.
     * Idempotent.
     */
    async markConvertedByToken(token: string, orderCode: string): Promise<
        { ok: true; cartId: number; orderCode: string; alreadyConverted: boolean }
        | { ok: false; error: 'invalid-token' | 'order-not-found' | 'order-not-placed' }
    > {
        const conn = adapterFor(this.connection.rawConnection);
        const t = String(token || '').trim();
        const code = sanitiseOrderCode(orderCode);
        if (!t || t.length > 128 || !code) return { ok: false, error: 'invalid-token' };
        const rows: any[] = await conn.query(
            `SELECT id, status, convertedOrderCode FROM abandoned_cart WHERE recoveryToken = ? LIMIT 1`,
            [t],
        );
        if (!rows?.length) return { ok: false, error: 'invalid-token' };
        const cart = rows[0];
        if (cart.status === 'converted' && cart.convertedOrderCode === code) {
            return { ok: true, cartId: Number(cart.id), orderCode: code, alreadyConverted: true };
        }
        const order = await this.lookupOrder(code);
        if (!order) return { ok: false, error: 'order-not-found' };
        if (order.state === 'AddingItems' || order.state === 'Cancelled' || order.state === 'Draft') {
            return { ok: false, error: 'order-not-placed' };
        }
        await conn.query(
            `UPDATE abandoned_cart
             SET status = 'converted',
                 recoveredAt = COALESCE(recoveredAt, NOW(3)),
                 convertedAt = COALESCE(convertedAt, NOW(3)),
                 convertedOrderId = ?,
                 convertedOrderCode = ?,
                 recoveryOrderId = COALESCE(recoveryOrderId, ?),
                 recoveryStep = 'converted'
             WHERE id = ?`,
            [order.id, order.code, order.id, cart.id],
        );
        Logger.log(`Recovery link converted: cart=${cart.id} order=${order.code}`, loggerCtx);
        return { ok: true, cartId: Number(cart.id), orderCode: order.code, alreadyConverted: false };
    }

    // ── opt-out ─────────────────────────────────────────────────────

    private optOutSecret(): string {
        return this.opts().optOutSecret;
    }

    /** True when the address has asked not to receive recovery emails.
     *  Hosts MUST check this before every send. Fail-open on DB errors
     *  would mean emailing someone who opted out, so this fails closed. */
    async isOptedOut(email: string): Promise<boolean> {
        const e = normaliseEmail(email);
        if (!e) return false;
        try {
            const conn = adapterFor(this.connection.rawConnection);
            const rows: any[] = await conn.query(
                `SELECT 1 AS x FROM abandoned_cart_opt_out WHERE emailHash = ? LIMIT 1`,
                [hashEmail(e)],
            );
            return !!rows?.length;
        } catch (err: any) {
            Logger.warn(`isOptedOut(${e}) failed — treating as opted out: ${err?.message}`, loggerCtx);
            return true;
        }
    }

    /** Record an opt-out. Idempotent. Returns false for a malformed email. */
    async optOut(email: string, meta: { source?: string; channelId?: number | null; ip?: string | null } = {}): Promise<boolean> {
        const e = normaliseEmail(email);
        if (!e) return false;
        const conn = adapterFor(this.connection.rawConnection);
        await conn.query(
            `INSERT INTO abandoned_cart_opt_out (emailHash, email, channelId, source, ip, createdAt)
             VALUES (?, ?, ?, ?, ?, NOW(3))
             ON DUPLICATE KEY UPDATE email = VALUES(email)`,
            [hashEmail(e), e, meta.channelId ?? null, String(meta.source || 'link').slice(0, 32), meta.ip ? String(meta.ip).slice(0, 45) : null],
            { conflictColumns: ['emailHash'] },
        );
        return true;
    }

    /** Remove an opt-out (admin action after an explicit customer request). */
    async optIn(email: string): Promise<boolean> {
        const e = normaliseEmail(email);
        if (!e) return false;
        const conn = adapterFor(this.connection.rawConnection);
        const res = await conn.query(
            `DELETE FROM abandoned_cart_opt_out WHERE emailHash = ?`,
            [hashEmail(e)],
            { needAffected: true },
        );
        return Number(res?.affectedRows ?? 0) > 0;
    }

    async listOptOuts(take = 50, skip = 0): Promise<{ items: any[]; total: number }> {
        const conn = adapterFor(this.connection.rawConnection);
        const [rows, totalRow] = await Promise.all([
            conn.query(
                `SELECT id, email, channelId, source, createdAt FROM abandoned_cart_opt_out
                 ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
                [take, skip],
            ),
            conn.query(`SELECT COUNT(*) AS c FROM abandoned_cart_opt_out`),
        ]);
        return { items: rows, total: Number(totalRow?.[0]?.c || 0) };
    }

    /** Absolute opt-out URL for an email, on the Vendure server's public
     *  origin. Null when no secret is configured. */
    buildOptOutLink(email: string): string | null {
        return buildOptOutUrl(getOptions().publicBaseUrl, email, this.optOutSecret());
    }

    /** `List-Unsubscribe` + `List-Unsubscribe-Post` headers for a recovery
     *  email to `email`. Null when opt-out links are disabled. */
    buildListUnsubscribeHeaders(email: string): { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string } | null {
        return buildListUnsubscribeHeaders(getOptions().publicBaseUrl, email, this.optOutSecret());
    }

    /** Exposed for the controller — verifies an `e=` token. */
    getOptOutSecret(): string {
        return this.optOutSecret();
    }

    // ── attribution ─────────────────────────────────────────────────

    /** Recovery-link funnel for the admin summary: how many carts got a
     *  link, how many opened it, resumed, converted — and the value of
     *  the carts the link brought back. */
    async attributionSummary(since: Date): Promise<{
        linkIssued: number;
        linkOpened: number;
        resumed: number;
        convertedViaLink: number;
        convertedViaLinkValueMinor: number;
        convertedTotal: number;
        optOuts: number;
    }> {
        const conn = adapterFor(this.connection.rawConnection);
        const rows: any[] = await conn.query(
            `SELECT
                SUM(CASE WHEN recoveryStep IS NOT NULL THEN 1 ELSE 0 END) AS linkIssued,
                SUM(CASE WHEN recoveryStep IN ('link_opened','resumed','converted') THEN 1 ELSE 0 END) AS linkOpened,
                SUM(CASE WHEN recoveryStep IN ('resumed','converted') THEN 1 ELSE 0 END) AS resumed,
                SUM(CASE WHEN recoveryStep = 'converted' THEN 1 ELSE 0 END) AS convertedViaLink,
                SUM(CASE WHEN recoveryStep = 'converted' THEN totalMinor ELSE 0 END) AS convertedViaLinkValueMinor,
                SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS convertedTotal
             FROM abandoned_cart
             WHERE abandonedAt >= ?`,
            [since],
        );
        let optOuts = 0;
        try {
            const o: any[] = await conn.query(`SELECT COUNT(*) AS c FROM abandoned_cart_opt_out WHERE createdAt >= ?`, [since]);
            optOuts = Number(o?.[0]?.c || 0);
        } catch { /* table missing on a very old install — reported as 0 */ }
        const s = rows?.[0] || {};
        return {
            linkIssued: Number(s.linkIssued || 0),
            linkOpened: Number(s.linkOpened || 0),
            resumed: Number(s.resumed || 0),
            convertedViaLink: Number(s.convertedViaLink || 0),
            convertedViaLinkValueMinor: Number(s.convertedViaLinkValueMinor || 0),
            convertedTotal: Number(s.convertedTotal || 0),
            optOuts,
        };
    }

    // ── order lookup ────────────────────────────────────────────────

    private async lookupOrder(code: string): Promise<OrderRow | null> {
        const c = sanitiseOrderCode(code);
        if (!c) return null;
        const conn = adapterFor(this.connection.rawConnection);
        try {
            const rows: any[] = await conn.query(
                'SELECT o.id, o.code, o.state, oc.channelId AS channelId\n' +
                'FROM `order` o LEFT JOIN order_channels_channel oc ON oc.orderId = o.id\n' +
                'WHERE o.code = ? LIMIT 1',
                [c],
            );
            if (!rows?.length) return null;
            const r = rows[0];
            return { id: Number(r.id), code: String(r.code), state: String(r.state), channelId: r.channelId == null ? null : Number(r.channelId) };
        } catch (e: any) {
            Logger.warn(`Order lookup for ${c} failed: ${e?.message}`, loggerCtx);
            return null;
        }
    }

    private async buildRecoveredCart(r: any): Promise<RecoveredCart> {
        let items: any[] = [];
        try { items = JSON.parse(r.itemsJson || '[]'); } catch {}
        const orderCode = sanitiseOrderCode(r.resumeOrderCode) || null;
        let orderState: string | null = null;
        if (orderCode) {
            const order = await this.lookupOrder(orderCode);
            orderState = order?.state ?? null;
        }
        return {
            id: Number(r.id),
            currency: String(r.currency || 'GBP'),
            items,
            email: r.email ?? null,
            orderCode,
            orderState,
            resumable: !!orderCode && isResumableOrderState(orderState),
            channelId: Number(r.channelId || 1),
        };
    }

    async markStatus(cartId: number, status: AbandonedCartStatus): Promise<boolean> {
        const conn = adapterFor(this.connection.rawConnection);
        const setRecovered = status === 'recovered' ? ', recoveredAt = NOW(3)' : '';
        const res = await conn.query(
            `UPDATE abandoned_cart SET status = ? ${setRecovered} WHERE id = ?`,
            [status, cartId],
            { needAffected: true },
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
