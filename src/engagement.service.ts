import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ProcessContext, TransactionalConnection } from '@vendure/core';
import {
    adapterFor, composeDigest, describeLicence, DigestMail, licenceLifecycleNotice, PluginPrefs,
    smtpTransportFromEnv, WeeklyDigest, WeeklyDigestSettings,
} from '@huloglobal/vendure-licence-sdk';
import { VisitorAnalyticsPlugin, getOptions } from './plugin';
import {
    ADMIN_ROUTE, buildSetupItems, EMPTY_STATS, PLUGIN_DISPLAY_NAME, PREMIUM_FEATURES, SetupItem, setupTips, SHORT_ID,
    toDigestStats, topRecentStats, UsageStats, widgetStats,
} from './engagement-stats';

const loggerCtx = 'VisitorEngagementService';
const DAY_MS = 86_400_000;

/**
 * Merchant engagement: usage stats for the evaluation client + heartbeat,
 * the Monday weekly report (`WeeklyDigest`), the set-up checklist and the
 * dashboard widget. Everything is fail-soft — a SQL or SMTP failure is
 * logged and reported as zeros / "not sent", never thrown into the host.
 */
@Injectable()
export class VisitorEngagementService implements OnApplicationBootstrap, OnModuleDestroy {
    readonly prefs: PluginPrefs;
    readonly digest: WeeklyDigest;
    private statsCache: { at: number; value: UsageStats } | null = null;

    constructor(
        private readonly connection: TransactionalConnection,
        private readonly processContext: ProcessContext,
    ) {
        this.prefs = new PluginPrefs((sql, params, opts) => this.query(sql, params, opts), SHORT_ID);
        this.digest = new WeeklyDigest({
            pluginId: SHORT_ID,
            pluginName: PLUGIN_DISPLAY_NAME,
            prefs: this.prefs,
            collect: (from, to) => this.collect(from, to),
            send: (to, mail) => this.send(to, mail),
            defaultRecipient: () => this.defaultRecipient(),
        });
    }

    private query(sql: string, params?: any[], opts?: { conflictColumns?: string[] }): Promise<any> {
        return adapterFor(this.connection.rawConnection).query(sql, params, opts);
    }

    async onApplicationBootstrap(): Promise<void> {
        await this.prefs.ensureTable();
        // Same numbers to the evaluation client (before purchase) and the
        // heartbeat (after it), so the licence server can say what the
        // plugin did in renewal and win-back mail.
        VisitorAnalyticsPlugin.setStatsProvider(() => this.evalStats());
        // Worker only: the server process never runs the weekly timer.
        if (this.processContext.isWorker) this.digest.start();
    }

    onModuleDestroy(): void {
        this.digest.stop();
    }

    // ── Usage stats ────────────────────────────────────────────────────

    /** Last 30 days, numbers only, no PII. Cached 5 minutes — the
     *  heartbeat, evaluation ping and licence banner all read it. */
    async evalStats(): Promise<Record<string, number>> {
        return { ...(await this.recentUsage()) };
    }

    /** The same 30-day counters, typed. */
    async recentUsage(): Promise<UsageStats> {
        const now = Date.now();
        if (!this.statsCache || now - this.statsCache.at > 5 * 60_000) {
            this.statsCache = { at: now, value: await this.statsBetween(new Date(now - 30 * DAY_MS), new Date(now)) };
        }
        return { ...this.statsCache.value };
    }

    /** Counters for `[from, to)`. Each query fails soft to zeros. */
    async statsBetween(from: Date, to: Date): Promise<UsageStats> {
        const out: UsageStats = { ...EMPTY_STATS };
        try {
            const [r] = await this.query(
                `SELECT COUNT(DISTINCT \`visitorId\`) AS visitors,
                        COUNT(DISTINCT \`sessionId\`) AS sessions,
                        SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
                        SUM(CASE WHEN \`goalId\` IS NOT NULL AND \`isBot\` = FALSE THEN 1 ELSE 0 END) AS goals
                 FROM visitor_event
                 WHERE \`createdAt\` >= ? AND \`createdAt\` < ?`,
                [from, to],
            );
            out.visitorsTracked = Number(r?.visitors) || 0;
            out.sessions = Number(r?.sessions) || 0;
            out.pageViews = Number(r?.pageviews) || 0;
            out.goalsCompleted = Number(r?.goals) || 0;
        } catch (e: any) {
            Logger.warn(`event stats failed: ${e?.message}`, loggerCtx);
        }
        try {
            const [c] = await this.query(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status IN ('recovered','converted') THEN 1 ELSE 0 END) AS recovered,
                        SUM(CASE WHEN status IN ('recovered','converted') THEN \`totalMinor\` ELSE 0 END) AS \`recoveredValue\`
                 FROM abandoned_cart
                 WHERE \`abandonedAt\` >= ? AND \`abandonedAt\` < ?`,
                [from, to],
            );
            out.cartsAbandoned = Number(c?.total) || 0;
            out.cartsRecovered = Number(c?.recovered) || 0;
            out.recoveredValuePence = Number(c?.recoveredValue) || 0;
        } catch (e: any) {
            Logger.warn(`cart stats failed: ${e?.message}`, loggerCtx);
        }
        return out;
    }

    // ── Licence / tier (exactly as `licence/status` computes it) ───────

    private tierInfo() {
        const status = VisitorAnalyticsPlugin.getLicenceStatus();
        const evalState = VisitorAnalyticsPlugin.getEvalState();
        const tier: 'paid' | 'trial' | 'free' = status?.valid ? 'paid' : (evalState?.active ? 'trial' : 'free');
        return { status, licence: describeLicence(status), evalState, tier };
    }

    adminUrl(): string | null {
        const base = String(getOptions().publicBaseUrl || '').trim().replace(/\/$/, '');
        return base ? `${base}/admin/extensions/${ADMIN_ROUTE}` : null;
    }

    /** Extra fields for `GET /ees/licence/status`. */
    async licenceExtras(): Promise<{
        notice: ReturnType<typeof licenceLifecycleNotice>;
        premiumFeatures: string[];
        recentStats: Array<{ label: string; value: string }>;
    }> {
        const t = this.tierInfo();
        let recentStats: Array<{ label: string; value: string }> = [];
        try { recentStats = topRecentStats(await this.recentUsage()); } catch { recentStats = []; }
        return {
            notice: licenceLifecycleNotice(t.licence, t.evalState, SHORT_ID),
            premiumFeatures: PREMIUM_FEATURES,
            recentStats,
        };
    }

    // ── Set-up checklist ───────────────────────────────────────────────

    async setup(): Promise<{ items: SetupItem[]; complete: boolean }> {
        const opts = getOptions();
        const ab: any = opts.abandonment || {};
        let hasRecentEvents = false;
        let goalsEnabled = 0;
        try {
            const rows: any[] = await this.query(
                `SELECT id FROM visitor_event WHERE \`createdAt\` >= DATE_SUB(NOW(), INTERVAL 7 DAY) LIMIT 1`,
            );
            hasRecentEvents = rows.length > 0;
        } catch { /* reported as not done */ }
        try {
            const [g] = await this.query(`SELECT COUNT(*) AS n FROM conversion_goal WHERE enabled = TRUE`);
            goalsEnabled = Number(g?.n) || 0;
        } catch { /* reported as not done */ }
        return buildSetupItems({
            hasRecentEvents,
            publicBaseUrl: String(opts.publicBaseUrl || ''),
            storefrontBaseUrlSet: !!(ab.storefrontBaseUrl || Object.keys(ab.storefrontBaseUrls || {}).length),
            goalsEnabled,
            slackWebhookSet: !!ab.slackWebhookUrl,
            recoverySecretSet: !!ab.recoveryLinkSecret,
        });
    }

    // ── Dashboard widget ───────────────────────────────────────────────

    async widget() {
        const t = this.tierInfo();
        const now = new Date();
        const stats = await this.statsBetween(new Date(now.getTime() - 7 * DAY_MS), now);
        return {
            tier: t.tier,
            notice: licenceLifecycleNotice(t.licence, t.evalState, SHORT_ID),
            stats: widgetStats(stats),
            route: `/extensions/${ADMIN_ROUTE}`,
        };
    }

    // ── Weekly report ──────────────────────────────────────────────────

    /** Report input for `[from, to)` with the previous period as deltas. */
    async collect(from: Date, to: Date) {
        const span = to.getTime() - from.getTime();
        const [current, previous] = await Promise.all([
            this.statsBetween(from, to),
            this.statsBetween(new Date(from.getTime() - span), from),
        ]);
        const setup = await this.setup();
        const t = this.tierInfo();
        return {
            stats: toDigestStats(current, previous),
            tips: setupTips(setup.items, this.adminUrl()),
            tier: t.tier,
            licence: t.licence,
            evalState: t.evalState,
            adminUrl: this.adminUrl(),
            premiumFeatures: PREMIUM_FEATURES,
        };
    }

    /** This plugin has no mailer of its own: SMTP_* env via the SDK. */
    async send(to: string, mail: DigestMail): Promise<unknown> {
        const transport = smtpTransportFromEnv();
        if (!transport) {
            throw new Error('SMTP is not configured — set SMTP_SERVER (or SMTP_HOST), SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM on the Vendure server, with nodemailer installed');
        }
        return transport.sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
    }

    /** Licence customer first, then the trial lead the admin gave us. */
    async defaultRecipient(): Promise<string | null> {
        const customer = describeLicence(VisitorAnalyticsPlugin.getLicenceStatus())?.customer;
        if (customer) return customer;
        return (await this.prefs.get('eval.leadEmail')) || null;
    }

    settings(): Promise<WeeklyDigestSettings> { return this.digest.settings(); }

    updateSettings(patch: { enabled?: boolean; recipient?: string | null }): Promise<WeeklyDigestSettings> {
        return this.digest.updateSettings(patch);
    }

    async sendTest(to?: string | null): Promise<{ sent: boolean; to: string | null; reason?: string; subject: string }> {
        const r = await this.digest.sendNow(to);
        return { sent: r.sent, to: r.to, ...(r.reason ? { reason: r.reason } : {}), subject: r.preview.subject };
    }

    /** Week-to-date report, rendered but not sent. */
    async preview(): Promise<DigestMail> {
        const end = new Date();
        const start = new Date(end.getTime() - 7 * DAY_MS);
        const partial = await this.collect(start, end);
        return composeDigest({ ...partial, pluginName: PLUGIN_DISPLAY_NAME, shortId: SHORT_ID, periodStart: start, periodEnd: end });
    }
}
