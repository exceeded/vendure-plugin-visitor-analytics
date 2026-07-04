import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { fingerprintPublicKey, Heartbeat, LicenceStatus, RetentionOptions, RevocationChecker, UpdateChecker, verifyLicence, warnIfIncompatibleVendure } from '@huloglobal/vendure-licence-sdk';
import { ConversionGoal } from './conversion-goal.entity';
import { VisitorEvent } from './visitor-event.entity';
import { VisitorTrackingService } from './visitor-tracking.service';
import { VisitorAnalyticsAdminResolver, visitorAnalyticsAdminApiSchema } from './admin-api';
import { VisitorTrackingController } from './visitor-tracking.controller';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../package.json').version;
const PKG_NAME = '@huloglobal/vendure-plugin-visitor-analytics';

export interface VisitorAnalyticsPluginOptions {
    /** Public host of the Vendure server. Used in licence host-match. */
    publicBaseUrl: string;
    /** JWT licence key. Without it the ingest endpoint accepts events
     *  and writes basic rows, but the admin analytics endpoints return
     *  403 — i.e. data collection works for evaluation but you can't
     *  read the dashboard without a licence. */
    licenceKey?: string;

    // ── Privacy ─────────────────────────────────────────────────────────
    /** When true (the default), respect the visitor's `DNT: 1` header —
     *  the ingest endpoint returns 200 immediately without writing a row. */
    honorDoNotTrack?: boolean;
    /** When true (the default), drop the last octet of the visitor IP
     *  before persisting. `ipHash` still uses the raw IP for unique
     *  counts so anonymisation doesn't break "unique visitor" totals. */
    anonymizeIp?: boolean;
    /** When true, refuse to ingest unless the request body sets
     *  `consent: true` or a request cookie `ees_consent=1` is present.
     *  Off by default — most installs handle consent client-side. */
    requireConsent?: boolean;
    /** When true, identified bot UAs are dropped instead of being
     *  ingested with `isBot=true`. Default false — keep bots so their
     *  share is visible on the dashboard. */
    dropBotEvents?: boolean;

    // ── Security ────────────────────────────────────────────────────────
    /** Rate limit per IP. Default 240 events / 60s. */
    rateLimit?: { capacity: number; windowMs: number };
    /** HMAC secret used to sign visitor + session cookies so tampered
     *  values are rejected at the ingest endpoint. When unset, cookies
     *  are not signed (legacy behaviour). Strongly recommend setting. */
    signingSecret?: string;
    /** Allowed CORS origins. When set, the `Access-Control-Allow-Origin`
     *  reflection is restricted to this list. When empty (default), any
     *  origin is reflected — matches legacy behaviour but is less safe. */
    corsAllowedOrigins?: string[];

    // ── Retention ───────────────────────────────────────────────────────
    /** Auto-prune `visitor_event` rows older than `days` days. */
    retention?: RetentionOptions;
}

const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoLmNM5UljRqe71drM6lR
Ba5vXrLOcV3GAHkYvnVFQSqdE0avrge/jsD7WdA6x8qQFNRugxQcxDJa2l0+C+BH
SbU9TimGwhA1yusHHfuz9LAXks5IQ48+2e6Pulh7iThXPJUnIKqKZUN5HhL79aaK
vrZKIgSfVhwE5PMPXWZ+Ij5IRf74PLIUn1Er75qhBXlDJ4vF8y8/3owURNC1XiUB
DGElwV/LYNoqAQei4oixe4EAxPGvFi11pgHiGuRxuWckA88y6ZHLt6urfAY9sCkj
kF+2dc2yS3j7lD+SYAaV5LQYYjePP1CYvxCZ7HHRKqthHopxY1hsK2tBtni3f7/c
UwIDAQAB
-----END PUBLIC KEY-----`;

const PLUGIN_ID = 'vendure-plugin-visitor-analytics';
const REVOCATION_URL = process.env.HULO_LICENCE_REVOCATION_URL
    || 'https://elite.charity/licence/revoked.json';

const DEFAULT_OPTIONS: VisitorAnalyticsPluginOptions = {
    publicBaseUrl: 'http://localhost:3000',
    honorDoNotTrack: true,
    anonymizeIp: true,
    requireConsent: false,
    dropBotEvents: false,
};

let cachedOptions: VisitorAnalyticsPluginOptions = DEFAULT_OPTIONS as any;
export function getOptions(): typeof DEFAULT_OPTIONS & VisitorAnalyticsPluginOptions {
    return { ...DEFAULT_OPTIONS, ...cachedOptions } as any;
}

/**
 * `@huloglobal/vendure-plugin-visitor-analytics`
 *
 * Full-funnel visitor analytics: page views, time-on-page, exit pages,
 * a configurable funnel, conversion goals, bot detection, and a
 * per-visitor profile drawer with parsed user-agent + MaxMind GeoLite2
 * enrichment.
 *
 * Survives login — guest events and signed-in events share the same
 * `visitorId`. Privacy-aware: honours DNT, anonymises IPs and supports
 * a consent gate, all toggleable via plugin options.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [VisitorTrackingService, VisitorAnalyticsAdminResolver],
    controllers: [VisitorTrackingController],
    entities: [VisitorEvent, ConversionGoal],
    compatibility: '^3.0.0',
    adminApiExtensions: {
        schema: visitorAnalyticsAdminApiSchema,
        resolvers: [VisitorAnalyticsAdminResolver],
    },
})
export class VisitorAnalyticsPlugin {
    private static revocation: RevocationChecker | null = null;
    private static updateChecker: UpdateChecker | null = null;
    private static heartbeat: Heartbeat | null = null;
    private static licenceStatus: LicenceStatus | null = null;

    static getUpdateChecker(): UpdateChecker | null { return VisitorAnalyticsPlugin.updateChecker; }
    static getPackageVersion(): string { return PKG_VERSION; }
    static getPackageName(): string { return PKG_NAME; }
    static getLicenceStatus(): LicenceStatus | null { return VisitorAnalyticsPlugin.licenceStatus; }

    static init(options: VisitorAnalyticsPluginOptions): Type<VisitorAnalyticsPlugin> {
        cachedOptions = options;

        // Warn if @vendure/core at runtime is outside the tested
        // range. Non-fatal — the plugin boots and works.
        warnIfIncompatibleVendure({
            pluginPackageName: PKG_NAME,
            pluginPackageVersion: PKG_VERSION,
            supportedRange: { min: '3.5.0', max: '4.0.0' },
        });

        if (!VisitorAnalyticsPlugin.revocation) {
            VisitorAnalyticsPlugin.revocation = new RevocationChecker(REVOCATION_URL);
            VisitorAnalyticsPlugin.revocation.start();
        }
        if (!VisitorAnalyticsPlugin.updateChecker) {
            VisitorAnalyticsPlugin.updateChecker = new UpdateChecker(PKG_NAME, PKG_VERSION);
            VisitorAnalyticsPlugin.updateChecker.start();
        }

        const host = (options.publicBaseUrl || '')
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const status = verifyLicence({
            licenceKey: options.licenceKey,
            pluginId: PLUGIN_ID,
            host,
            publicKey: HULO_PUBLIC_KEY,
            revokedIds: VisitorAnalyticsPlugin.revocation.getRevokedIds(),
        });
        VisitorAnalyticsPlugin.licenceStatus = status;

        if (!status.valid) {
            // eslint-disable-next-line no-console
            console.warn(
                `[@huloglobal/vendure-plugin-visitor-analytics] ${status.message}` +
                ` — Running in FREE tier: 100 events/day cap, conversion goals disabled, live SSE feed disabled, CSV export disabled. Buy a licence at https://elite.charity/licence/buy/${PLUGIN_ID}`,
            );
        }

        if (!VisitorAnalyticsPlugin.heartbeat) {
            VisitorAnalyticsPlugin.heartbeat = new Heartbeat({
                packageName: PKG_NAME,
                packageVersion: PKG_VERSION,
                licenceKey: options.licenceKey,
                publicKeyFingerprint: fingerprintPublicKey(HULO_PUBLIC_KEY),
            });
            VisitorAnalyticsPlugin.heartbeat.start();
        }

        return VisitorAnalyticsPlugin;
    }

    static uiExtensions = {
        extensionPath: __dirname + '/../ui',
        ngModules: [
            {
                type: 'lazy' as const,
                route: 'visitors',
                ngModuleFileName: 'visitors.module.ts',
                ngModuleName: 'VisitorsModule',
            },
        ],
    };
}
