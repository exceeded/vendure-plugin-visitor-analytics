/**
 * Lightweight bot detection. Catches the ~95% of crawlers /
 * monitoring probes / API tools that identify themselves in the UA
 * string. We deliberately keep this conservative — a false negative
 * just means a bot was counted; a false positive removes a real human
 * from the dashboard.
 */

const BOT_PATTERNS = [
    /\bbot\b/i, /spider/i, /crawler/i, /preview/i,
    /googlebot/i, /bingbot/i, /duckduckbot/i, /yandex/i, /baidu/i,
    /facebookexternalhit/i, /facebot/i, /twitterbot/i, /linkedinbot/i,
    /slackbot/i, /telegrambot/i, /discordbot/i, /whatsapp/i,
    /applebot/i, /amazonbot/i, /pinterestbot/i, /redditbot/i,
    /ahrefsbot/i, /semrushbot/i, /mj12bot/i, /dotbot/i, /yandeximages/i,
    /uptimerobot/i, /pingdom/i, /statuscake/i, /datadog/i, /newrelic/i,
    /curl\//i, /wget\//i, /python-requests/i, /python-urllib/i, /libwww/i,
    /node-fetch/i, /axios/i, /go-http-client/i, /java\//i, /okhttp/i,
    /headlesschrome/i, /phantomjs/i, /selenium/i, /puppeteer/i, /playwright/i,
];

export function isBotUa(ua: string | null | undefined): boolean {
    if (!ua) return false;
    return BOT_PATTERNS.some(p => p.test(ua));
}

/**
 * Drop the last octet of an IPv4 or the last 80 bits of an IPv6 so we
 * keep approximately /24 / /48 granularity — enough to count uniques
 * by network without storing exact addresses. Used when the
 * `anonymizeIp` plugin option is on (the default).
 */
export function anonymizeIp(ip: string | null): string | null {
    if (!ip) return null;
    if (ip.includes(':')) {
        // IPv6 — keep first 3 hextets.
        const parts = ip.split(':');
        if (parts.length < 3) return ip;
        return parts.slice(0, 3).join(':') + '::';
    }
    if (ip.includes('.')) {
        const parts = ip.split('.');
        if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
    return ip;
}
