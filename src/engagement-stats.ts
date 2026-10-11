/**
 * Decorator-free helpers behind the weekly report, the set-up checklist,
 * the dashboard widget and the usage-stats providers (so they unit-test
 * without the Nest/Vendure runtime). All numbers come from real queries
 * in `engagement.service.ts`; nothing here invents a figure.
 */
import type { DigestFormat, DigestStat, DigestTip } from '@huloglobal/vendure-licence-sdk';
import { formatStat } from '@huloglobal/vendure-licence-sdk';

export const SHORT_ID = 'vendure-plugin-visitor-analytics';
export const PLUGIN_DISPLAY_NAME = 'Visitor Analytics';
export const ADMIN_ROUTE = 'visitors';
export const BUY_URL = `https://elite.charity/licence/buy/${SHORT_ID}`;
export const DOCS_URL = 'https://huloglobal.com/vendure-plugins/visitor-analytics/docs/';

/** What the free tier loses — shown on trial/free banners and in the report. */
export const PREMIUM_FEATURES: string[] = [
    'Unlimited events (free tier: 100/day)',
    'Live visitors view',
    'Abandoned-cart recovery links and Slack alerts',
    'Conversion goals and CSV export',
];

/** Usage counters for a period. Numbers only, no personal data. */
export interface UsageStats {
    /** Unique visitors (distinct visitor ids). */
    visitorsTracked: number;
    sessions: number;
    pageViews: number;
    /** Carts the scanner flagged as abandoned in the period. */
    cartsAbandoned: number;
    /** Abandoned carts later marked recovered or converted. */
    cartsRecovered: number;
    /** Value of those recovered carts, in minor units. */
    recoveredValuePence: number;
    /** Pageviews that matched an enabled conversion goal (bots excluded). */
    goalsCompleted: number;
}

export const EMPTY_STATS: UsageStats = {
    visitorsTracked: 0, sessions: 0, pageViews: 0,
    cartsAbandoned: 0, cartsRecovered: 0, recoveredValuePence: 0, goalsCompleted: 0,
};

/** Report order + merchant-facing labels. */
export const STAT_DEFS: Array<{ key: keyof UsageStats; label: string; format: DigestFormat }> = [
    { key: 'visitorsTracked', label: 'unique visitors tracked', format: 'count' },
    { key: 'sessions', label: 'sessions', format: 'count' },
    { key: 'pageViews', label: 'page views', format: 'count' },
    { key: 'cartsAbandoned', label: 'abandoned carts detected', format: 'count' },
    { key: 'cartsRecovered', label: 'carts recovered', format: 'count' },
    { key: 'recoveredValuePence', label: 'of cart value recovered', format: 'pence' },
    { key: 'goalsCompleted', label: 'conversion goals completed', format: 'count' },
];

/** Priority for the "So far: …" banner line — the most valuable figures first. */
const RECENT_ORDER: Array<keyof UsageStats> = [
    'recoveredValuePence', 'cartsRecovered', 'goalsCompleted', 'visitorsTracked', 'pageViews', 'cartsAbandoned', 'sessions',
];

export function toDigestStats(current: UsageStats, previous?: UsageStats | null): DigestStat[] {
    return STAT_DEFS.map(d => ({
        key: d.key, label: d.label, format: d.format,
        value: Number(current[d.key]) || 0,
        previous: previous ? (Number(previous[d.key]) || 0) : null,
    }));
}

/** Top `n` non-zero figures of a period, formatted for a banner line. */
export function topRecentStats(stats: UsageStats, n = 3): Array<{ label: string; value: string }> {
    const out: Array<{ label: string; value: string }> = [];
    for (const key of RECENT_ORDER) {
        const v = Number(stats[key]) || 0;
        if (v <= 0) continue;
        const d = STAT_DEFS.find(x => x.key === key)!;
        out.push({ label: d.label, value: formatStat({ key, label: d.label, value: v, format: d.format }) });
        if (out.length >= n) break;
    }
    return out;
}

/** Three headline figures for the dashboard widget. */
export function widgetStats(stats: UsageStats): Array<{ label: string; value: string }> {
    const f = (key: keyof UsageStats, label: string) => {
        const d = STAT_DEFS.find(x => x.key === key)!;
        return { label, value: formatStat({ key, label, value: Number(stats[key]) || 0, format: d.format }) };
    };
    return [f('visitorsTracked', 'Unique visitors (7d)'), f('pageViews', 'Page views (7d)'), f('cartsRecovered', 'Carts recovered (7d)')];
}

// ── Set-up checklist ───────────────────────────────────────────────────

export interface SetupFacts {
    /** Any `visitor_event` row in the last 7 days. */
    hasRecentEvents: boolean;
    publicBaseUrl: string;
    /** `abandonment.storefrontBaseUrl` or a per-channel map is configured. */
    storefrontBaseUrlSet: boolean;
    /** Enabled rows in `conversion_goal`. */
    goalsEnabled: number;
    slackWebhookSet: boolean;
    recoverySecretSet: boolean;
}

export interface SetupItem {
    key: string;
    label: string;
    done: boolean;
    hint: string;
    tab?: string;
    url?: string;
}

/** A real public origin: http(s) and not a loopback / unspecified host. */
export function isPublicBaseUrl(raw: string | undefined | null): boolean {
    const s = String(raw || '').trim();
    if (!/^https?:\/\//i.test(s)) return false;
    try {
        const h = new URL(s).hostname.toLowerCase();
        return !!h && !['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(h) && !h.endsWith('.local');
    } catch { return false; }
}

export function buildSetupItems(facts: SetupFacts): { items: SetupItem[]; complete: boolean } {
    const base = String(facts.publicBaseUrl || '').replace(/\/$/, '');
    const items: SetupItem[] = [
        {
            key: 'tracking',
            label: 'Tracking script receiving events',
            done: facts.hasRecentEvents,
            hint: `Add <script src="${base || ''}/ees/hulo.js"></script> to your storefront's <head>. Events show here within a minute of the first page load.`,
            url: DOCS_URL,
        },
        {
            key: 'publicBaseUrl',
            label: 'Public base URL set',
            done: isPublicBaseUrl(facts.publicBaseUrl),
            hint: 'Set publicBaseUrl in VisitorAnalyticsPlugin.init() to the public address of this server — recovery links, opt-out links and the weekly report link are built from it.',
            url: DOCS_URL,
        },
        {
            key: 'storefrontUrl',
            label: 'Storefront URL for recovery links',
            done: facts.storefrontBaseUrlSet,
            hint: 'Set abandonment.storefrontBaseUrl (or storefrontBaseUrls per channel code) so cart-recovery links land on the right storefront.',
            url: DOCS_URL,
        },
        {
            key: 'goal',
            label: 'At least one conversion goal',
            done: facts.goalsEnabled > 0,
            hint: 'Create a goal (e.g. /checkout/confirmation/*) with POST /ees/goals or the admin API so completions and goal value appear on the dashboard. Premium — included in the evaluation.',
            url: DOCS_URL,
        },
        {
            key: 'alerts',
            label: 'Abandoned-cart alerts or recovery links enabled',
            done: facts.slackWebhookSet || facts.recoverySecretSet,
            hint: 'Set abandonment.slackWebhookUrl for Slack alerts and/or abandonment.recoveryLinkSecret to mint recovery links. Premium — included in the evaluation.',
            url: DOCS_URL,
        },
    ];
    return { items, complete: items.every(i => i.done) };
}

/** 1–3 "next step" nudges for the weekly report: the undone items, in order. */
export function setupTips(items: SetupItem[], adminUrl?: string | null): DigestTip[] {
    return items.filter(i => !i.done).slice(0, 3).map(i => ({
        title: i.label,
        body: i.hint,
        url: adminUrl || i.url,
        linkLabel: adminUrl ? 'Open in Admin' : 'Docs',
    }));
}
