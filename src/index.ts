/**
 * `@huloglobal/vendure-plugin-visitor-analytics` — public exports.
 */

export { VisitorAnalyticsPlugin, VisitorAnalyticsPluginOptions } from './plugin';
export { VisitorTrackingService } from './visitor-tracking.service';
export { VisitorEvent } from './visitor-event.entity';
export { AbandonedCart, AbandonedCartStatus } from './abandoned-cart.entity';
export { ProductCoView } from './product-co-view.entity';
export {
    AbandonedCartService,
    CartSnapshotMeta,
    AbandonmentOptions,
    IssueRecoveryLinkOptions,
    RecoveredCart,
    ResumedCart,
} from './abandoned-cart.service';
export {
    RecoveryStep,
    RESUMABLE_ORDER_STATES,
    isResumableOrderState,
    advanceRecoveryStep,
    normaliseEmail,
    hashEmail,
    buildOptOutToken,
    verifyOptOutToken,
    buildOptOutUrl,
    buildListUnsubscribeHeaders,
} from './recovery-tokens';
export { RecommendationsService, RecommendedProduct } from './recommendations.service';
export { SearchAnalyticsService } from './search-analytics.service';
export { JourneyBuffsService } from './journey-buffs.service';
