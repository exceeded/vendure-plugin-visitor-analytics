import { Injectable, Logger } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';

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

    /**
     * Rebuild the co-view aggregate from `visitor_event`. Idempotent
     * per (A, B, channelId) — repeated calls over the same window
     * accumulate, so schedule this as a nightly cron with a rolling
     * lookback (e.g. last 24h) rather than a full-history rescan.
     *
     * Returns the number of pair-triples updated. Uses a bounded
     * ordered-pair extractor (max 20 events per session) so a single
     * bot session can't skew the table.
     */
    async aggregateCoViews(sinceHours = 24): Promise<{ pairs: number }> {
        const conn = this.connection.rawConnection;
        const since = new Date(Date.now() - sinceHours * 3600_000);
        // Extract every session's product-view sequence within the
        // window. Bounded to 20 events per session to keep pathological
        // sessions from blowing up the table.
        const sessions: any[] = await conn.query(
            `SELECT
                sessionId,
                channelId,
                GROUP_CONCAT(
                    SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"productId":', -1), ',', 1)
                    ORDER BY createdAt
                    SEPARATOR ','
                ) AS ids
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"product_view"%'
               AND createdAt >= ?
             GROUP BY sessionId, channelId
             HAVING COUNT(*) BETWEEN 2 AND 20`,
            [since],
        );

        let pairs = 0;
        for (const s of sessions) {
            const rawIds: number[] = String(s.ids || '')
                .split(',')
                .map((x: string) => parseInt(x.replace(/[^0-9]/g, ''), 10))
                .filter((n: number) => Number.isFinite(n) && n > 0);
            if (rawIds.length < 2) continue;
            const uniq = Array.from(new Set(rawIds));
            if (uniq.length < 2) continue;

            for (let i = 0; i < uniq.length; i++) {
                for (let j = 0; j < uniq.length; j++) {
                    if (i === j) continue;
                    const a = uniq[i];
                    const b = uniq[j];
                    // Upsert-with-increment via ON DUPLICATE KEY UPDATE.
                    await conn.query(
                        `INSERT INTO product_co_view
                           (productIdA, productIdB, channelId, viewsTogether, lastUpdated)
                         VALUES (?, ?, ?, 1, NOW(3))
                         ON DUPLICATE KEY UPDATE
                           viewsTogether = viewsTogether + 1,
                           lastUpdated = NOW(3)`,
                        [a, b, s.channelId || 1],
                    );
                    pairs += 1;
                }
            }
        }
        Logger.log(`Co-view aggregation: ${sessions.length} sessions, ${pairs} pair updates`, loggerCtx);
        return { pairs };
    }

    /**
     * Read side: "customers who viewed X also viewed Y" for one
     * product, ordered by co-view score, capped at `limit`.
     */
    async alsoViewed(productId: number, channelId = 1, limit = 10): Promise<RecommendedProduct[]> {
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT productIdB AS productId, viewsTogether AS score
             FROM product_co_view
             WHERE productIdA = ? AND channelId = ?
             ORDER BY viewsTogether DESC, lastUpdated DESC
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
        const conn = this.connection.rawConnection;
        const seeds: any[] = await conn.query(
            `SELECT DISTINCT
                CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"productId":', -1), ',', 1) AS UNSIGNED) AS productId
             FROM visitor_event
             WHERE visitorId = ?
               AND type = 'event'
               AND meta LIKE '%"eventType":"product_view"%'
               AND createdAt >= (NOW() - INTERVAL 30 DAY)
             ORDER BY createdAt DESC
             LIMIT 10`,
            [visitorId],
        );
        const seedIds = seeds.map(s => Number(s.productId)).filter(n => n > 0);
        if (!seedIds.length) return [];
        const placeholders = seedIds.map(() => '?').join(',');
        const rows: any[] = await conn.query(
            `SELECT productIdB AS productId, SUM(viewsTogether) AS score
             FROM product_co_view
             WHERE productIdA IN (${placeholders})
               AND channelId = ?
               AND productIdB NOT IN (${placeholders})
             GROUP BY productIdB
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
        const since = new Date(Date.now() - sinceHours * 3600_000);
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"productId":', -1), ',', 1) AS UNSIGNED) AS productId,
                COUNT(*) AS views
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"product_view"%'
               AND channelId = ?
               AND createdAt >= ?
             GROUP BY productId
             HAVING productId > 0
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
            const rows: any[] = await this.connection.rawConnection.query(
                `SELECT pt.baseId AS productId, pt.name, pt.slug
                 FROM product_translation pt
                 JOIN product p ON p.id = pt.baseId AND p.deletedAt IS NULL
                 WHERE pt.baseId IN (${placeholders})
                 ORDER BY pt.baseId, pt.languageCode = 'en' DESC`,
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
