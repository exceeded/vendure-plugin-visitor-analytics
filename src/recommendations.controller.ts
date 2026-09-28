import { Controller, Get, Query } from '@nestjs/common';
import { Ctx, RequestContext, Allow, Permission } from '@vendure/core';
import { RecommendationsService } from './recommendations.service';

/**
 * Public + admin API for the co-view recommendations feature.
 *
 * The `also-viewed`, `personal` and `trending` endpoints are safe to
 * hit from the storefront directly — they return only product ids +
 * scores, no PII. Restricting them to Vendure admin would break the
 * primary use case (rendering a recs rail on the product page).
 */
const TRENDING_CACHE = new Map<string, { items: any[]; exp: number }>();

@Controller('ees')
export class RecommendationsController {
    constructor(private readonly service: RecommendationsService) {}

    /**
     * "Customers who viewed X also viewed…"
     *   /ees/recommendations/also-viewed?productId=42&channelId=1&limit=10
     */
    @Get('recommendations/also-viewed')
    async alsoViewed(
        @Query('productId') pRaw?: string,
        @Query('channelId') chRaw?: string,
        @Query('limit')     lRaw?: string,
    ) {
        const productId = parseInt(pRaw || '0', 10);
        if (!productId) return { error: 'productId-required' };
        const channelId = parseInt(chRaw || '1', 10) || 1;
        const limit = parseInt(lRaw || '10', 10) || 10;
        const items = await this.service.alsoViewed(productId, channelId, limit);
        return { productId, items };
    }

    /**
     * Personalised recs for a returning visitor:
     *   /ees/recommendations/personal?visitorId=abc&channelId=1&limit=10
     *
     * Storefronts should send the current `ees_vid` cookie value —
     * the same one the ingest endpoint issues.
     */
    @Get('recommendations/personal')
    async personal(
        @Query('visitorId') vRaw?: string,
        @Query('channelId') chRaw?: string,
        @Query('limit')     lRaw?: string,
    ) {
        const visitorId = String(vRaw || '').trim();
        if (!visitorId) return { error: 'visitorId-required' };
        const channelId = parseInt(chRaw || '1', 10) || 1;
        const limit = parseInt(lRaw || '10', 10) || 10;
        const items = await this.service.personalRecommendations(visitorId, channelId, limit);
        return { visitorId, items };
    }

    /**
     * Most-viewed products in the window:
     *   /ees/recommendations/trending?channelId=1&hours=24&limit=10
     */
    @Get('recommendations/trending')
    async trending(
        @Query('channelId') chRaw?: string,
        @Query('hours')     hRaw?: string,
        @Query('limit')     lRaw?: string,
    ) {
        const channelId = parseInt(chRaw || '1', 10) || 1;
        // Public and uncached before: a GROUP BY over a month of events per call. Cap the window and memoise for a minute.
        const hours = Math.min(Math.max(1, parseInt(hRaw || '24', 10) || 24), 24 * 7);
        const limit = Math.min(Math.max(1, parseInt(lRaw || '10', 10) || 10), 50);
        const key = `${channelId}|${hours}|${limit}`;
        const hit = TRENDING_CACHE.get(key);
        if (hit && hit.exp > Date.now()) return { channelId, hours, items: hit.items };
        const items = await this.service.trending(channelId, hours, limit);
        if (TRENDING_CACHE.size > 200) TRENDING_CACHE.clear();
        TRENDING_CACHE.set(key, { items, exp: Date.now() + 60_000 });
        return { channelId, hours, items };
    }

    /**
     * Admin-only: run the aggregation now. Idempotent — events up to the
     * persisted watermark of the last sweep are not counted again, so
     * calling this right after the 6-hourly cron adds nothing (the
     * response says `skipped: true`). `?force=1` ignores the watermark,
     * e.g. after truncating `product_co_view`.
     */
    @Get('recommendations/aggregate-now')
    @Allow(Permission.SuperAdmin)
    async aggregateNow(@Ctx() ctx: RequestContext, @Query('hours') hRaw?: string, @Query('force') force?: string) {
        const hours = Math.min(Math.max(1, parseInt(hRaw || '24', 10) || 24), 24 * 30);
        const result = await this.service.aggregateCoViews(hours, { force: force === '1' || force === 'true' });
        return { ok: true, hours, ...result };
    }
}
