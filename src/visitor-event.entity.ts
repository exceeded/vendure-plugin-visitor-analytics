import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * Stores a single visitor analytics event — used to map the customer
 * journey across the storefront, including for visitors who never log in.
 *
 *   type='pageview' — a new page was opened (one row per navigation)
 *   type='unload'   — a page was closed / hidden; `timeOnPageMs` is the
 *                     time the visitor spent on it before leaving
 *   type='event'    — a custom event raised by the frontend (e.g. an
 *                     add-to-cart click); the payload lives in `meta`
 *
 * `visitorId` is a long-lived cookie UUID (2 years) — identifies the
 * device across sessions. `sessionId` is a short-lived cookie UUID
 * (30-minute idle expiry) — identifies a single browsing burst.
 *
 * `customerId` is set when the visitor is logged in; the same
 * `visitorId` can carry guest events first and then customer events
 * once the visitor signs in / signs up — that's what makes the funnel
 * analysis work.
 */
@Entity()
@Index('visitor_event_visitor_idx', ['visitorId', 'createdAt'])
@Index('visitor_event_session_idx', ['sessionId', 'createdAt'])
@Index('visitor_event_customer_idx', ['customerId'])
@Index('visitor_event_type_idx', ['type', 'createdAt'])
@Index('visitor_event_url_idx', ['url'])
export class VisitorEvent extends VendureEntity {
    constructor(input?: DeepPartial<VisitorEvent>) { super(input); }

    @Column({ length: 64 })
    visitorId!: string;

    @Column({ length: 64 })
    sessionId!: string;

    @Column({ type: 'int', nullable: true })
    customerId!: number | null;

    @Column({ type: 'int', default: 1 })
    channelId!: number;

    @Column({ length: 32 })
    type!: 'pageview' | 'unload' | 'event' | string;

    /** Pathname + search, no host. Capped at 2048 to fit Cloudflare's max URL. */
    @Column({ length: 2048 })
    url!: string;

    /** Document title at the time of the event — useful for the journey
     *  timeline so the admin sees "Product: Windows 11" instead of just
     *  "/products/microsoft-windows-11-professional/". */
    @Column({ type: 'varchar', length: 500, nullable: true })
    title!: string | null;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    referrer!: string | null;

    /** Set only on `unload` rows — milliseconds the visitor spent on the
     *  page before leaving. */
    @Column({ type: 'int', nullable: true })
    timeOnPageMs!: number | null;

    /** Hash of the visitor's IP address — kept for spot-the-same-IP-bot
     *  analysis even after the raw IP is purged. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    ipHash!: string | null;

    /** Raw client IP. Max length 45 chars covers full IPv6 + zone id. */
    @Column({ type: 'varchar', length: 45, nullable: true })
    ip!: string | null;

    @Column({ type: 'varchar', length: 1000, nullable: true })
    userAgent!: string | null;

    /** Parsed user-agent — populated server-side at ingest. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    browser!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    browserVersion!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    os!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    osVersion!: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    device!: string | null;

    /** `Accept-Language` header, capped. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    acceptLanguage!: string | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    country!: string | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    region!: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    city!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    timezone!: string | null;

    /** Arbitrary JSON payload for `type='event'` rows. */
    @Column({ type: 'text', nullable: true })
    meta!: string | null;

    // ── UTM attribution ──────────────────────────────────────────────────
    // Captured server-side from the event URL on every pageview. When a
    // visitor lands on `/products/?utm_source=google&utm_medium=cpc` these
    // five columns are populated. The referrer domain is also captured
    // so admin reports can group by source even when UTM params are
    // absent.

    @Column({ type: 'varchar', length: 100, nullable: true })
    utmSource!: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    utmMedium!: string | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    utmCampaign!: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    utmTerm!: string | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    utmContent!: string | null;

    /** Lowercased host of `referrer` (e.g. `google.com`, `facebook.com`).
     *  Stored alongside the full referrer string so admin reports can
     *  group by domain without parsing every URL at read time. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    referrerDomain!: string | null;
}
