import { Injectable, Logger } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
import { adapterFor, LicenceStore } from '@huloglobal/vendure-licence-sdk';
import { PRODUCT_CO_VIEW_CONFLICT, PRODUCT_ID_TOKEN, PRODUCT_ID_TOKEN_LOOSE, digitsOnly } from './sql-fragments';

const loggerCtx = 'HuloRecommendationsService';

/** Row shape returned by every read-side endpoint. `productName` and
 *  `productSlug` are best-effort enrichments — they'll be null when
 *  the product has been deleted or when the `product_translation`
 *  table doesn't have a row for it in any language. */
export interface RecommendedProduct {
    productId: number;
    productName: string | null;
    productSlug: string | null;
    /** Numeric score returned by whichever endpoint produced this row.
     *  Callers should read `score` for co-view based responses and
     *  `views` for the raw trending endpoint — both are populated
     *  here so a UI can render one column regardless. */
    score: number;
    views: number;
}

/**
 * Product recommendations driven by observed co-viewing behaviour.
 *
 * The scanner walks recent `product_view` custom events grouped by
 * session, extracts every ordered pair, and increments a counter per
 * `(productIdA, productIdB, channelId)` triple. We denormalise both
 * directions (`A → B` AND `B → A`) so read-side lookups are one
 * indexed scan.
 *
 * "Also viewed" is far simpler than "also bought" — you need orders
 * data for the latter, and small stores don't have enough of it for
 * useful signals. Co-views come from every browsing session, so a
 * store with 1k daily visitors gets useful recs from day one.
 *
 * Every read-side response is enriched with the product NAME and
 * SLUG (via a single bulk lookup against `product_translation`) so
 * the admin UI + a first-party storefront can render "Windows Server
 * 2022 Datacenter #42" without a second round-trip. Bare product ids
 * are still returned so storefronts that prefer their own hydration
 * path can ignore the extra fields.
 */
@Injectable()
export class RecommendationsService {
    constructor(private connection: TransactionalConnection) {}

    /** Persisted high-water mark of the last aggregated window (event time). */
    private static readonly WATERMARK_KEY = 'visitor-analytics-coview-watermark';
    private watermark: Date | null = null;
    private aggregating = false;

    private store() {
        return new LicenceStore((sql, params) => adapterFor(this.connection.rawConnection).query(sql, params));
    }

    /**
     * Rebuild the co-view aggregate from `visitor_event` for the window
     * `[since, now)`. Idempotent for overlapping calls: the end of the last
     * aggregated window is persisted, and a later call only counts events
     * after it (`aggregate-now` after the 6-hourly cron therefore adds
     * nothing instead of doubling every pair). `force: true` ignores the
     * watermark (e.g. after truncating `product_co_view`).
     *
     * Pairs are accumulated in memory per (A, B, channel) and written as
     * multi-row upserts in chunks of 500 — the previous version issued one
     * round trip per ordered pair, so a 20-product session cost 380 statements.
     *
     * Bounded to 20 events per session so a single bot session cannot skew
     * the table.
     */
    async aggregateCoViews(sinceHours = 24, opts: { force?: boolean } = {}): Promise<{ pairs: number; sessions: number; since: string; until: string; skipped: boolean }> {
        const conn = adapterFor(this.connection.rawConnection);
        const until = new Date();
        let since = new Date(until.getTime() - sinceHours * 3600_000);
        if (this.aggregating) return { pairs: 0, sessions: 0, since: since.toISOString(), until: until.toISOString(), skipped: true };
        this.aggregating = true;
        try {
            if (!opts.force) {
                const mark = await this.loadWatermark();
                if (mark && mark > since) since = mark;
            }
            if (since >= until) return { pairs: 0, sessions: 0, since: since.toISOString(), until: until.toISOString(), skipped: true };

            const sessions: any[] = await conn.query(
                `SELECT
                    \`sessionId\`,
                    \`channelId\`,
                    GROUP_CONCAT(
                        ${PRODUCT_ID_TOKEN_LOOSE}
                        ORDER BY \`createdAt\`
                        SEPARATOR ','
                    ) AS ids
                 FROM visitor_event
                 WHERE type = 'event'
                   AND meta LIKE '%"eventType":"product_view"%'
                   AND \`createdAt\` >= ?
                   AND \`createdAt\` < ?
                 GROUP BY \`sessionId\`, \`channelId\`
                 HAVING COUNT(*) BETWEEN 2 AND 20`,
                [since, until],
            );

            // (a, b, channel) → co-view count for this window.
            const counts = new Map<string, { a: number; b: number; ch: number; n: number }>();
            for (const s of sessions) {
                const rawIds: number[] = String(s.ids || '')
                    .split(',')
                    .map((x: string) => parseInt(x.replace(/[^0-9]/g, ''), 10))
                    .filter((n: number) => Number.isFinite(n) && n > 0);
                const uniq = Array.from(new Set(rawIds));
                if (uniq.length < 2) continue;
                const ch = Number(s.channelId) || 1;
                for (const a of uniq) {
                    for (const b of uniq) {
                        if (a === b) continue;
                        const key = `${a}|${b}|${ch}`;
                        const hit = counts.get(key);
                        if (hit) hit.n += 1; else counts.set(key, { a, b, ch, n: 1 });
                    }
                }
            }

            const rows = Array.from(counts.values());
            const CHUNK = 500;
            for (let i = 0; i < rows.length; i += CHUNK) {
                const chunk = rows.slice(i, i + CHUNK);
                const valuesSql = chunk.map(() => '(?, ?, ?, ?, NOW(3))').join(', ');
                await conn.query(
                    `INSERT INTO product_co_view
                       (\`productIdA\`, \`productIdB\`, \`channelId\`, \`viewsTogether\`, \`lastUpdated\`)
                     VALUES ${valuesSql}
                     ON DUPLICATE KEY UPDATE
                       \`viewsTogether\` = product_co_view.\`viewsTogether\` + VALUES(\`viewsTogether\`),
                       \`lastUpdated\` = NOW(3)`,
                    chunk.flatMap(r => [r.a, r.b, r.ch, r.n]),
                    { conflictColumns: PRODUCT_CO_VIEW_CONFLICT },
                );
            }
            await this.saveWatermark(until);
            Logger.log(`Co-view aggregation: ${sessions.length} sessions, ${rows.length} pair rows (${since.toISOString()} → ${until.toISOString()})`, loggerCtx);
            return { pairs: rows.length, sessions: sessions.length, since: since.toISOString(), until: until.toISOString(), skipped: false };
        } finally {
            this.aggregating = false;
        }
    }

    private async loadWatermark(): Promise<Date | null> {
        if (this.watermark) return this.watermark;
        try {
            const store = this.store();
            await store.ensureTable();
            const raw = await store.load(RecommendationsService.WATERMARK_KEY);
            const d = raw ? new Date(raw) : null;
            this.watermark = d && Number.isFinite(d.getTime()) ? d : null;
        } catch { this.watermark = null; }
        return this.watermark;
    }

    private async saveWatermark(until: Date): Promise<void> {
        this.watermark = until;
        try { await this.store().save(RecommendationsService.WATERMARK_KEY, until.toISOString()); }
        catch (e: any) { Logger.warn(`co-view watermark not persisted: ${e?.message}`, loggerCtx); }
    }

    /** Monthly housekeeping (worker): pairs not refreshed for `days` go in batches. */
    async pruneStalePairs(days = 90, batch = 5000): Promise<number> {
        const conn = adapterFor(this.connection.rawConnection);
        let deleted = 0;
        for (let round = 0; round < 400; round++) {
            const rows: any[] = await conn.query(
                `SELECT \`productIdA\`, \`productIdB\`, \`channelId\` FROM product_co_view
                 WHERE \`lastUpdated\` < DATE_SUB(NOW(), INTERVAL ? DAY)
                 ORDER BY \`productIdA\`, \`productIdB\`, \`channelId\` LIMIT ?`,
                [days, batch],
            );
            if (!rows.length) break;
            const tuples = rows.map(() => '(?, ?, ?)').join(', ');
            await conn.query(
                `DELETE FROM product_co_view WHERE (\`productIdA\`, \`productIdB\`, \`channelId\`) IN (${tuples})`,
                rows.flatMap((r: any) => [Number(r.productIdA), Number(r.productIdB), Number(r.channelId)]),
            );
            deleted += rows.length;
            if (rows.length < batch) break;
        }
        return deleted;
    }

    /**
     * Read side: "customers who viewed X also viewed Y" for one
     * product, ordered by co-view score, capped at `limit`.
     */
    async alsoViewed(productId: number, channelId = 1, limit = 10): Promise<RecommendedProduct[]> {
        const rows: any[] = await adapterFor(this.connection.rawConnection).query(
            `SELECT \`productIdB\` AS \`productId\`, \`viewsTogether\` AS score
             FROM product_co_view
             WHERE \`productIdA\` = ? AND \`channelId\` = ?
             ORDER BY \`viewsTogether\` DESC, \`lastUpdated\` DESC
             LIMIT ?`,
            [productId, channelId, Math.min(Math.max(1, limit), 50)],
        );
        return this.enrichWithNames(rows.map(r => ({
            productId: Number(r.productId),
            score: Number(r.score),
            views: Number(r.score),
        })));
    }

    /**
     * Personalised recommendations for a returning visitor: look at
     * the last N products they viewed, and rank co-viewed products by
     * combined score across those seed products (excluding the seeds
     * themselves).
     */
    async personalRecommendations(visitorId: string, channelId = 1, limit = 10): Promise<RecommendedProduct[]> {
        const conn = adapterFor(this.connection.rawConnection);
        // No DISTINCT + ORDER BY on an unselected column (Postgres rejects it):
        // group by the extracted id and order by the latest view instead.
        const seeds: any[] = await conn.query(
            `SELECT CAST(${PRODUCT_ID_TOKEN} AS UNSIGNED) AS \`productId\`, MAX(\`createdAt\`) AS \`lastSeen\`
             FROM visitor_event
             WHERE \`visitorId\` = ?
               AND type = 'event'
               AND meta LIKE '%"eventType":"product_view"%'
               AND \`createdAt\` >= DATE_SUB(NOW(), INTERVAL 30 DAY)
               AND ${digitsOnly(conn.dialect, PRODUCT_ID_TOKEN)}
             GROUP BY CAST(${PRODUCT_ID_TOKEN} AS UNSIGNED)
             ORDER BY \`lastSeen\` DESC
             LIMIT 10`,
            [visitorId],
        );
        const seedIds = seeds.map(s => Number(s.productId)).filter(n => n > 0);
        if (!seedIds.length) return [];
        const placeholders = seedIds.map(() => '?').join(',');
        const rows: any[] = await conn.query(
            `SELECT \`productIdB\` AS \`productId\`, SUM(\`viewsTogether\`) AS score
             FROM product_co_view
             WHERE \`productIdA\` IN (${placeholders})
               AND \`channelId\` = ?
               AND \`productIdB\` NOT IN (${placeholders})
             GROUP BY \`productIdB\`
             ORDER BY score DESC
             LIMIT ?`,
            [...seedIds, channelId, ...seedIds, Math.min(Math.max(1, limit), 50)],
        );
        return this.enrichWithNames(rows.map(r => ({
            productId: Number(r.productId),
            score: Number(r.score),
            views: Number(r.score),
        })));
    }

    /**
     * "Trending now" — most-viewed products in the last N hours.
     * Useful for a homepage rail; uses `product_view` events, so it
     * reflects real interest, not just search-console clicks.
     */
    async trending(channelId = 1, sinceHours = 24, limit = 10): Promise<RecommendedProduct[]> {
        const conn = adapterFor(this.connection.rawConnection);
        const since = new Date(Date.now() - sinceHours * 3600_000);
        // The digits guard keeps CAST from raising on Postgres; GROUP BY / HAVING repeat
        // the expression because Postgres does not resolve output aliases in HAVING.
        const rows: any[] = await conn.query(
            `SELECT
                CAST(${PRODUCT_ID_TOKEN} AS UNSIGNED) AS \`productId\`,
                COUNT(*) AS views
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"product_view"%'
               AND \`channelId\` = ?
               AND \`createdAt\` >= ?
               AND ${digitsOnly(conn.dialect, PRODUCT_ID_TOKEN)}
             GROUP BY CAST(${PRODUCT_ID_TOKEN} AS UNSIGNED)
             HAVING CAST(${PRODUCT_ID_TOKEN} AS UNSIGNED) > 0
             ORDER BY views DESC
             LIMIT ?`,
            [channelId, since, Math.min(Math.max(1, limit), 50)],
        );
        return this.enrichWithNames(rows.map(r => ({
            productId: Number(r.productId),
            score: Number(r.views),
            views: Number(r.views),
        })));
    }

    /**
     * Bulk-fetch product names + slugs for a list of product ids in
     * one round-trip. Prefers the English translation when a product
     * has more than one, then falls back to whichever translation
     * MariaDB returns first. Returns two maps keyed by productId; keys
     * absent from the maps mean the product either doesn't exist any
     * more or has no translation row at all (unusual — Vendure
     * always creates one on product create).
     */
    private async fetchProductInfo(ids: number[]): Promise<{
        names: Map<number, string>;
        slugs: Map<number, string>;
    }> {
        const names = new Map<number, string>();
        const slugs = new Map<number, string>();
        if (!ids.length) return { names, slugs };
        const placeholders = ids.map(() => '?').join(',');
        try {
            // `deletedAt IS NULL` on product so we don't surface
            // soft-deleted products in the admin UI. Order by
            // languageCode = 'en' DESC so English wins the tie for
            // multi-locale stores; single-locale installs will
            // naturally land on their only translation.
            const rows: any[] = await adapterFor(this.connection.rawConnection).query(
                `SELECT pt.\`baseId\` AS \`productId\`, pt.name, pt.slug
                 FROM product_translation pt
                 JOIN product p ON p.id = pt.\`baseId\` AND p.\`deletedAt\` IS NULL
                 WHERE pt.\`baseId\` IN (${placeholders})
                 ORDER BY pt.\`baseId\`, pt.\`languageCode\` = 'en' DESC`,
                ids,
            );
            for (const r of rows) {
                const id = Number(r.productId);
                // First-write wins — the ORDER BY puts English first
                // for each baseId, so we keep that one and skip
                // subsequent translations.
                if (!names.has(id)) names.set(id, String(r.name || ''));
                if (!slugs.has(id)) slugs.set(id, String(r.slug || ''));
            }
        } catch (e: any) {
            // Never break the recs endpoint on a name-lookup failure —
            // an admin can still see the id and click through to the
            // Vendure catalog page manually.
            Logger.warn(`Product info lookup failed: ${e?.message}`, loggerCtx);
        }
        return { names, slugs };
    }

    /** Apply the bulk name lookup to a set of raw rec rows. */
    private async enrichWithNames(rows: Array<{
        productId: number;
        score: number;
        views: number;
    }>): Promise<RecommendedProduct[]> {
        const ids = rows.map(r => r.productId);
        const { names, slugs } = await this.fetchProductInfo(ids);
        return rows.map(r => ({
            productId: r.productId,
            productName: names.get(r.productId) || null,
            productSlug: slugs.get(r.productId) || null,
            score: r.score,
            views: r.views,
        }));
    }
}
