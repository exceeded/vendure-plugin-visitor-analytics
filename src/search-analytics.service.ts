import { Injectable } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';

/**
 * Zero-schema-cost search analytics: reads back over the existing
 * `visitor_event` table where the storefront has posted `type='event'`,
 * `eventType='search'` custom events, and aggregates them per query
 * string.
 *
 * The storefront just needs to fire:
 *   hulo.search('rgb keyboard', 42)   // (query, resultsCount)
 *
 * Everything else lives in the read side.
 */
@Injectable()
export class SearchAnalyticsService {
    constructor(private connection: TransactionalConnection) {}

    /** Top search queries in the window, by volume. */
    async topQueries(sinceDays = 7, channelId = 1, limit = 50): Promise<Array<{
        query: string;
        searches: number;
        avgResults: number;
    }>> {
        const since = new Date(Date.now() - sinceDays * 86400_000);
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                LOWER(TRIM(BOTH '"' FROM SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"query":"', -1), '"', 1))) AS query,
                COUNT(*) AS searches,
                AVG(CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"resultsCount":', -1), ',', 1) AS UNSIGNED)) AS avgResults
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"search"%'
               AND channelId = ?
               AND createdAt >= ?
             GROUP BY query
             HAVING query <> ''
             ORDER BY searches DESC
             LIMIT ?`,
            [channelId, since, Math.min(Math.max(1, limit), 500)],
        );
        return rows.map(r => ({
            query: String(r.query || ''),
            searches: Number(r.searches),
            avgResults: Math.round(Number(r.avgResults || 0) * 10) / 10,
        }));
    }

    /** Zero-result queries — catalogue-gap intel. */
    async zeroResultQueries(sinceDays = 7, channelId = 1, limit = 50): Promise<Array<{
        query: string;
        searches: number;
    }>> {
        const since = new Date(Date.now() - sinceDays * 86400_000);
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                LOWER(TRIM(BOTH '"' FROM SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"query":"', -1), '"', 1))) AS query,
                COUNT(*) AS searches
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"search"%'
               AND meta LIKE '%"resultsCount":0%'
               AND channelId = ?
               AND createdAt >= ?
             GROUP BY query
             HAVING query <> ''
             ORDER BY searches DESC
             LIMIT ?`,
            [channelId, since, Math.min(Math.max(1, limit), 500)],
        );
        return rows.map(r => ({ query: String(r.query || ''), searches: Number(r.searches) }));
    }

    /** Search-to-cart-add conversion — of sessions that searched, what
     *  fraction went on to fire an add_to_cart. Coarse, but the direction
     *  of movement is what matters for catalogue tuning. */
    async searchToAddRate(sinceDays = 7, channelId = 1): Promise<{
        sessionsSearched: number;
        sessionsAdded: number;
        conversion: number;
    }> {
        const since = new Date(Date.now() - sinceDays * 86400_000);
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                COUNT(DISTINCT ve.sessionId) AS sessionsSearched,
                COUNT(DISTINCT CASE WHEN adds.sessionId IS NOT NULL THEN ve.sessionId END) AS sessionsAdded
             FROM visitor_event ve
             LEFT JOIN (
                SELECT DISTINCT sessionId FROM visitor_event
                WHERE type = 'event'
                  AND meta LIKE '%"eventType":"add_to_cart"%'
                  AND channelId = ?
                  AND createdAt >= ?
             ) adds ON adds.sessionId = ve.sessionId
             WHERE ve.type = 'event'
               AND ve.meta LIKE '%"eventType":"search"%'
               AND ve.channelId = ?
               AND ve.createdAt >= ?`,
            [channelId, since, channelId, since],
        );
        const r = rows?.[0] || {};
        const searched = Number(r.sessionsSearched || 0);
        const added = Number(r.sessionsAdded || 0);
        return {
            sessionsSearched: searched,
            sessionsAdded: added,
            conversion: searched ? Math.round((added / searched) * 1000) / 10 : 0,
        };
    }
}
