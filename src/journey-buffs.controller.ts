import { Controller, Get, Query } from '@nestjs/common';
import { Ctx, RequestContext, Allow, Permission } from '@vendure/core';
import { JourneyBuffsService } from './journey-buffs.service';

@Controller('ees')
export class JourneyBuffsController {
    constructor(private readonly service: JourneyBuffsService) {}

    /** GET /ees/journey/rage-clicks?days=7&channelId=1&limit=20 */
    @Get('journey/rage-clicks')
    @Allow(Permission.ReadCustomer)
    async rage(
        @Ctx() ctx: RequestContext,
        @Query('days') d?: string,
        @Query('channelId') ch?: string,
        @Query('limit') l?: string,
    ) {
        const items = await this.service.rageClickHotSpots(
            +(d || 7), +(ch || 1), +(l || 20),
        );
        return { items };
    }

    /** GET /ees/journey/dead-clicks?days=7&channelId=1&limit=20 */
    @Get('journey/dead-clicks')
    @Allow(Permission.ReadCustomer)
    async dead(
        @Ctx() ctx: RequestContext,
        @Query('days') d?: string,
        @Query('channelId') ch?: string,
        @Query('limit') l?: string,
    ) {
        const items = await this.service.deadClickHotSpots(
            +(d || 7), +(ch || 1), +(l || 20),
        );
        return { items };
    }

    /** GET /ees/journey/session-summary?visitorId=abc&limit=25 */
    @Get('journey/session-summary')
    @Allow(Permission.ReadCustomer)
    async summary(
        @Ctx() ctx: RequestContext,
        @Query('visitorId') v?: string,
        @Query('limit') l?: string,
    ) {
        const visitorId = String(v || '').trim();
        if (!visitorId) return { error: 'visitorId-required' };
        const items = await this.service.sessionSummary(visitorId, +(l || 25));
        return { visitorId, items };
    }
}
