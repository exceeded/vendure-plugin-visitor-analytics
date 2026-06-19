import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { RevocationChecker, verifyLicence } from '@hulo/vendure-licence-sdk';
import { VisitorEvent } from './visitor-event.entity';
import { VisitorTrackingService } from './visitor-tracking.service';
import { VisitorTrackingController } from './visitor-tracking.controller';

export interface VisitorAnalyticsPluginOptions {
    /** Public host of the Vendure server. Used in licence host-match. */
    publicBaseUrl: string;
    /** JWT licence key. Without it the ingest endpoint accepts events
     *  and writes basic rows, but the admin analytics endpoints return
     *  403 — i.e. data collection works for evaluation but you can't
     *  read the dashboard without a licence. */
    licenceKey?: string;
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

/**
 * `@hulo/vendure-plugin-visitor-analytics`
 *
 * Full-funnel visitor analytics: page views, time-on-page, exit pages,
 * a configurable funnel, and a per-visitor profile drawer with
 * parsed user-agent + MaxMind GeoLite2 geo enrichment. Survives login
 * — guest events and signed-in events share the same `visitorId`.
 *
 * Add to your Vendure config:
 *
 * ```ts
 * import { VisitorAnalyticsPlugin } from '@hulo/vendure-plugin-visitor-analytics';
 *
 * export const config: VendureConfig = {
 *   plugins: [
 *     VisitorAnalyticsPlugin.init({
 *       publicBaseUrl: 'https://shop.example.com',
 *       licenceKey: process.env.HULO_LICENCE_KEY,
 *     }),
 *   ],
 * };
 * ```
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [VisitorTrackingService],
    controllers: [VisitorTrackingController],
    entities: [VisitorEvent],
    compatibility: '^3.0.0',
})
export class VisitorAnalyticsPlugin {
    private static revocation: RevocationChecker | null = null;

    static init(options: VisitorAnalyticsPluginOptions): Type<VisitorAnalyticsPlugin> {
        if (!VisitorAnalyticsPlugin.revocation) {
            VisitorAnalyticsPlugin.revocation = new RevocationChecker(REVOCATION_URL);
            VisitorAnalyticsPlugin.revocation.start();
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

        if (!status.valid) {
            // eslint-disable-next-line no-console
            console.warn(
                `[@hulo/vendure-plugin-visitor-analytics] ${status.message}` +
                ` — Running in unlicensed mode (ingest works, admin dashboards disabled). Purchase a key at https://elite-software.co.uk/licence/buy/${PLUGIN_ID}`,
            );
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
