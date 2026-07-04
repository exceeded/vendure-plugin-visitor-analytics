import { Injectable, Logger } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';

const loggerCtx = 'HuloRecommendationsService';

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
     * product, ordered by co-view score, capped at `limit`. Returns
     * bare product ids so the storefront can hydrate names / images
     * from its usual product-fetch path.
     */
    async alsoViewed(productId: number, channelId = 1, limit = 10): Promise<Array<{
        productId: number;
        score: number;
    }>> {
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT productIdB AS productId, viewsTogether AS score
             FROM product_co_view
             WHERE productIdA = ? AND channelId = ?
             ORDER BY viewsTogether DESC, lastUpdated DESC
             LIMIT ?`,
            [productId, channelId, Math.min(Math.max(1, limit), 50)],
        );
        return rows.map(r => ({ productId: Number(r.productId), score: Number(r.score) }));
    }

    /**
     * Personalised recommendations for a returning visitor: look at
     * the last N products they viewed, and rank co-viewed products by
     * combined score across those seed products (excluding the seeds
     * themselves).
     */
    async personalRecommendations(visitorId: string, channelId = 1, limit = 10): Promise<Array<{
        productId: number;
        score: number;
    }>> {
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
        return rows.map(r => ({ productId: Number(r.productId), score: Number(r.score) }));
    }

    /**
     * "Trending now" — most-viewed products in the last N hours.
     * Useful for a homepage rail; uses `product_view` events, so it
     * reflects real interest, not just search-console clicks.
     */
    async trending(channelId = 1, sinceHours = 24, limit = 10): Promise<Array<{
        productId: number;
        views: number;
    }>> {
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
        return rows.map(r => ({ productId: Number(r.productId), views: Number(r.views) }));
    }
}
