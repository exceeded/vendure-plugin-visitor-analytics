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
        const hours = Math.min(Math.max(1, parseInt(hRaw || '24', 10) || 24), 24 * 30);
        const limit = parseInt(lRaw || '10', 10) || 10;
        const items = await this.service.trending(channelId, hours, limit);
        return { channelId, hours, items };
    }

    /**
     * Admin-only: manually kick the aggregation cron. Normally runs
     * nightly, but this is useful for smoke-testing after a data
     * backfill, or for pushing a big spike through immediately.
     */
    @Get('recommendations/aggregate-now')
    @Allow(Permission.SuperAdmin)
    async aggregateNow(@Ctx() ctx: RequestContext, @Query('hours') hRaw?: string) {
        const hours = Math.min(Math.max(1, parseInt(hRaw || '24', 10) || 24), 24 * 30);
        const result = await this.service.aggregateCoViews(hours);
        return { ok: true, hours, ...result };
    }
}
