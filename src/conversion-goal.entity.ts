import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * A configurable funnel-completion target. Each goal is matched against
 * every incoming `pageview` event — when a pageview's URL satisfies the
 * pattern, the visitor is counted as having completed that goal.
 *
 *   Pattern syntax (cheap glob, not regex):
 *     • `*`  — match zero or more chars within a path segment
 *     • `**` — match zero or more segments
 *     • Anything else is a literal substring match
 *
 *   Examples:
 *     /checkout/thank-you/*                — confirmation step
 *     /signup                              — exact path
 *     **\/wishlist                        — any wishlist page on any tenant
 */
@Entity()
export class ConversionGoal extends VendureEntity {
    constructor(input?: DeepPartial<ConversionGoal>) { super(input); }

    @Index()
    @Column({ type: 'int', default: 1 })
    channelId!: number;

    @Column({ type: 'varchar', length: 128 })
    name!: string;

    @Column({ type: 'varchar', length: 256 })
    urlPattern!: string;

    /** Monetary value attached to a conversion, in the channel currency's
     * minor units (pence / cents). Lets the dashboard show total goal
     * value over a period. */
    @Column({ type: 'int', default: 0 })
    valueMinor!: number;

    @Column({ type: 'boolean', default: true })
    enabled!: boolean;
}
