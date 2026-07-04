import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ProcessContext } from '@vendure/core';
import { AbandonedCartService } from './abandoned-cart.service';
import { RecommendationsService } from './recommendations.service';

const loggerCtx = 'HuloAnalyticsScanner';

/**
 * Runs the two periodic sweeps this plugin depends on:
 *
 *   1. Abandoned-cart detection — every 5 minutes.
 *      Any session with `cart_snapshot` events but no
 *      `checkout_completed` in the abandonment window gets promoted.
 *
 *   2. Product co-view aggregation — every 6 hours.
 *      Walks recent `product_view` events and accumulates the
 *      pair counter used by the recommendations endpoints.
 *
 * Runs on the *worker* process only, not the server, so a horizontally
 * scaled deployment doesn't run the sweeps N times per interval.
 * Falls through cleanly on the server (bootstrap is a no-op).
 *
 * Uses `setInterval` rather than `@nestjs/schedule` — that package
 * is only present on installs that opt in to it. This keeps the
 * plugin's runtime footprint minimal.
 */
@Injectable()
export class AbandonedCartScanner implements OnApplicationBootstrap, OnApplicationShutdown {
    private cartTimer: NodeJS.Timeout | null = null;
    private recsTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly cartSvc: AbandonedCartService,
        private readonly recsSvc: RecommendationsService,
        private readonly processContext: ProcessContext,
    ) {}

    onApplicationBootstrap() {
        // Only the worker process runs the sweeps. Guard here rather
        // than throwing — a mono-process dev setup still works.
        if (!this.processContext.isWorker) return;

        this.cartTimer = setInterval(() => {
            this.cartSvc.scan().catch((e: any) => {
                Logger.error(`Abandoned-cart scan failed: ${e?.message}`, loggerCtx);
            });
        }, 5 * 60_000);
        // Fire once at boot so a fresh install doesn't wait 5 min for
        // its first sweep.
        this.cartSvc.scan().catch((e: any) => {
            Logger.error(`Initial abandoned-cart scan failed: ${e?.message}`, loggerCtx);
        });

        this.recsTimer = setInterval(() => {
            this.recsSvc.aggregateCoViews(6).catch((e: any) => {
                Logger.error(`Co-view aggregation failed: ${e?.message}`, loggerCtx);
            });
        }, 6 * 60 * 60_000);

        Logger.log('Abandoned-cart + recommendations scanners started (worker)', loggerCtx);
    }

    onApplicationShutdown() {
        if (this.cartTimer) { clearInterval(this.cartTimer); this.cartTimer = null; }
        if (this.recsTimer) { clearInterval(this.recsTimer); this.recsTimer = null; }
    }
}
