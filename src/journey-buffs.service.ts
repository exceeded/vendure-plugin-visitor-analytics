import { Injectable } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';

/**
 * Zero-schema-cost enrichment endpoints for the per-visitor Journey
 * drawer and store-wide UX signals.
 *
 * Each of these queries reads back over the existing `visitor_event`
 * table where the storefront has fired named custom events. No new
 * columns, no new tables — the storefront helper is documented in the
 * plugin README and dispatches events into the existing
 * `POST /ees/track` endpoint.
 */
@Injectable()
export class JourneyBuffsService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Store-wide rage-click hot spots — the URLs where visitors are
     * most frustrated. `hulo.rageClick(url, selector)` on the
     * storefront populates the underlying event.
     */
    async rageClickHotSpots(sinceDays = 7, channelId = 1, limit = 20): Promise<Array<{
        url: string;
        rageClicks: number;
        uniqueVisitors: number;
    }>> {
        const since = new Date(Date.now() - sinceDays * 86400_000);
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                url,
                COUNT(*) AS rageClicks,
                COUNT(DISTINCT visitorId) AS uniqueVisitors
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"rage_click"%'
               AND channelId = ?
               AND createdAt >= ?
             GROUP BY url
             ORDER BY rageClicks DESC
             LIMIT ?`,
            [channelId, since, Math.min(Math.max(1, limit), 200)],
        );
        return rows.map(r => ({
            url: String(r.url || ''),
            rageClicks: Number(r.rageClicks),
            uniqueVisitors: Number(r.uniqueVisitors),
        }));
    }

    /**
     * Dead-click hot spots — clicks on non-interactive elements. Same
     * shape as rage-click aggregation but keyed on the `dead_click`
     * event type. Useful for spotting elements that LOOK clickable
     * (styled headings, disabled buttons, decorative cards).
     */
    async deadClickHotSpots(sinceDays = 7, channelId = 1, limit = 20): Promise<Array<{
        url: string;
        deadClicks: number;
        uniqueVisitors: number;
    }>> {
        const since = new Date(Date.now() - sinceDays * 86400_000);
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                url,
                COUNT(*) AS deadClicks,
                COUNT(DISTINCT visitorId) AS uniqueVisitors
             FROM visitor_event
             WHERE type = 'event'
               AND meta LIKE '%"eventType":"dead_click"%'
               AND channelId = ?
               AND createdAt >= ?
             GROUP BY url
             ORDER BY deadClicks DESC
             LIMIT ?`,
            [channelId, since, Math.min(Math.max(1, limit), 200)],
        );
        return rows.map(r => ({
            url: String(r.url || ''),
            deadClicks: Number(r.deadClicks),
            uniqueVisitors: Number(r.uniqueVisitors),
        }));
    }

    /**
     * Per-visitor session summary — one row per session with a
     * heuristic `intent` label. Used to enrich the Journey drawer
     * with a one-line "what did this session do".
     */
    async sessionSummary(visitorId: string, limit = 25): Promise<Array<{
        sessionId: string;
        startedAt: string;
        endedAt: string;
        durationSec: number;
        pageCount: number;
        addedToCart: boolean;
        checkedOut: boolean;
        rageClicked: boolean;
        intent: 'browse' | 'consider' | 'purchase' | 'abandon' | 'frustrate' | 'bounce';
    }>> {
        const rows: any[] = await this.connection.rawConnection.query(
            `SELECT
                sessionId,
                MIN(createdAt) AS startedAt,
                MAX(createdAt) AS endedAt,
                COUNT(*) AS pageCount,
                SUM(type = 'event' AND meta LIKE '%"eventType":"add_to_cart"%') > 0        AS addedToCart,
                SUM(type = 'event' AND meta LIKE '%"eventType":"checkout_completed"%') > 0 AS checkedOut,
                SUM(type = 'event' AND meta LIKE '%"eventType":"cart_snapshot"%') > 0      AS hadCartSnapshot,
                SUM(type = 'event' AND meta LIKE '%"eventType":"rage_click"%') > 0         AS rageClicked
             FROM visitor_event
             WHERE visitorId = ?
             GROUP BY sessionId
             ORDER BY startedAt DESC
             LIMIT ?`,
            [visitorId, Math.min(Math.max(1, limit), 200)],
        );
        return rows.map(r => {
            const start = new Date(r.startedAt);
            const end = new Date(r.endedAt);
            const durationSec = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
            const pageCount = Number(r.pageCount);
            const addedToCart = !!Number(r.addedToCart);
            const checkedOut = !!Number(r.checkedOut);
            const hadCartSnapshot = !!Number(r.hadCartSnapshot);
            const rageClicked = !!Number(r.rageClicked);
            let intent: 'browse' | 'consider' | 'purchase' | 'abandon' | 'frustrate' | 'bounce';
            if (checkedOut) intent = 'purchase';
            else if (hadCartSnapshot || addedToCart) intent = 'abandon';
            else if (rageClicked) intent = 'frustrate';
            else if (pageCount <= 1 && durationSec < 15) intent = 'bounce';
            else if (pageCount >= 5) intent = 'consider';
            else intent = 'browse';
            return {
                sessionId: String(r.sessionId),
                startedAt: start.toISOString(),
                endedAt: end.toISOString(),
                durationSec,
                pageCount,
                addedToCart,
                checkedOut,
                rageClicked,
                intent,
            };
        });
    }
}
