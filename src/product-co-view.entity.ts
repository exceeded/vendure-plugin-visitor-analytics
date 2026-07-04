import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Aggregate table for "customers who viewed X also viewed Y".
 *
 * Denormalised: we store both `(A, B)` and `(B, A)` so lookups by either
 * side are a single indexed scan. Cheap on disk (int, int, int, int),
 * expensive nowhere.
 *
 * Rebuilt by a nightly cron that walks recent `product_view` events per
 * session, extracts all ordered pairs, and increments the counter. The
 * scanner also decays old scores so trending products bubble up.
 */
@Entity('product_co_view')
@Index('product_co_view_score_idx', ['productIdA', 'channelId', 'viewsTogether'])
export class ProductCoView {
    @PrimaryColumn({ type: 'int' })
    productIdA!: number;

    @PrimaryColumn({ type: 'int' })
    productIdB!: number;

    @PrimaryColumn({ type: 'int', default: 1 })
    channelId!: number;

    @Column({ type: 'int', default: 0 })
    viewsTogether!: number;

    @Column({ type: 'datetime', precision: 3 })
    lastUpdated!: Date;
}
