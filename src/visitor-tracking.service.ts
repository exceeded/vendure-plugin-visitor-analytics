import { Injectable, Logger } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
import { createHash, randomUUID } from 'crypto';
import { VisitorEvent } from './visitor-event.entity';

const loggerCtx = 'VisitorTrackingService';

interface IngestInput {
    visitorId: string;
    sessionId: string;
    customerId: number | null;
    channelId: number;
    events: Array<{
        type: 'pageview' | 'unload' | 'event' | string;
        url: string;
        title?: string | null;
        referrer?: string | null;
        timeOnPageMs?: number | null;
        meta?: any;
        clientTs?: number;
    }>;
    ip?: string | null;
    userAgent?: string | null;
    acceptLanguage?: string | null;
    /** Resolved country / region from an upstream proxy (Cloudflare /
     *  Akamai / Fastly). When present these take precedence over the
     *  local MaxMind lookup, which is then skipped — saves ~1ms per
     *  event and avoids a disk read. */
    proxyCountry?: string | null;
    proxyRegion?: string | null;
}

interface EnrichedContext {
    ip: string | null;
    ipHash: string | null;
    userAgent: string | null;
    acceptLanguage: string | null;
    browser: string | null;
    browserVersion: string | null;
    os: string | null;
    osVersion: string | null;
    device: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    timezone: string | null;
}

let _maxmindReader: any | null = null;
let _maxmindInit: Promise<void> | null = null;

@Injectable()
export class VisitorTrackingService {
    constructor(private connection: TransactionalConnection) {}

    /** Persist a batch of events with full enrichment. */
    async ingest(input: IngestInput): Promise<{ stored: number }> {
        if (!input?.events?.length) return { stored: 0 };
        const repo = this.connection.rawConnection.getRepository(VisitorEvent);

        const enriched = await this.enrichContext(input);

        const rows = input.events.map(e => repo.create({
            visitorId: input.visitorId,
            sessionId: input.sessionId,
            customerId: input.customerId,
            channelId: input.channelId,
            type: String(e.type || 'pageview').slice(0, 32),
            url: (e.url || '').slice(0, 2048),
            title: e.title ? String(e.title).slice(0, 500) : null,
            referrer: e.referrer ? String(e.referrer).slice(0, 2048) : null,
            timeOnPageMs: typeof e.timeOnPageMs === 'number' && e.timeOnPageMs >= 0
                ? Math.min(e.timeOnPageMs, 60 * 60_000)
                : null,
            ...enriched,
            meta: e.meta ? JSON.stringify(e.meta).slice(0, 4000) : null,
        }));

        try {
            await repo.save(rows);
        } catch (err: any) {
            Logger.warn(`ingest failed: ${err?.message}`, loggerCtx);
            return { stored: 0 };
        }
        return { stored: rows.length };
    }

    /** Build the full enrichment context — UA parsing + MaxMind geo + IP
     *  hash. Errors anywhere here collapse to null so a bad lookup never
     *  drops the event itself. */
    private async enrichContext(input: IngestInput): Promise<EnrichedContext> {
        const ip = input.ip ? input.ip.slice(0, 45) : null;
        const ipHash = ip ? this.hashIp(ip) : null;
        const ua = input.userAgent ? input.userAgent.slice(0, 1000) : null;
        const acceptLanguage = input.acceptLanguage ? input.acceptLanguage.slice(0, 200) : null;

        let browser: string | null = null;
        let browserVersion: string | null = null;
        let os: string | null = null;
        let osVersion: string | null = null;
        let device: string | null = null;
        if (ua) {
            try {
                const { UAParser } = await import('ua-parser-js');
                const parsed = new UAParser(ua).getResult();
                browser = parsed.browser.name?.slice(0, 64) || null;
                browserVersion = parsed.browser.version?.slice(0, 64) || null;
                os = parsed.os.name?.slice(0, 64) || null;
                osVersion = parsed.os.version?.slice(0, 64) || null;
                // ua-parser device.type is one of: console, mobile, tablet,
                // smarttv, wearable, embedded, xr. Default (desktop) is
                // undefined.
                device = (parsed.device.type as string | undefined)?.slice(0, 32)
                    || (isBot(ua) ? 'bot' : 'desktop');
            } catch {
                // ua-parser-js failed to load — fall through with nulls.
            }
        }

        let country: string | null = input.proxyCountry || null;
        let region: string | null = input.proxyRegion || null;
        let city: string | null = null;
        let timezone: string | null = null;
        // Only fall back to MaxMind when the upstream proxy didn't already
        // resolve the country — saves disk I/O on every event when
        // Cloudflare / Akamai is in front of Vendure.
        if (!country && ip && !isLocalIp(ip)) {
            try {
                const reader = await getMaxmindReader();
                if (reader) {
                    const r = reader.city(ip);
                    country = r.country?.isoCode?.slice(0, 16) || null;
                    region = r.subdivisions?.[0]?.isoCode?.slice(0, 16) || null;
                    city = r.city?.names?.en?.slice(0, 100) || null;
                    timezone = r.location?.timeZone?.slice(0, 64) || null;
                }
            } catch {
                // address not in DB — leave geo fields null.
            }
        }

        return {
            ip, ipHash, userAgent: ua, acceptLanguage,
            browser, browserVersion, os, osVersion, device,
            country, region, city, timezone,
        };
    }

    private hashIp(ip: string): string {
        const salt = process.env.VISITOR_IP_SALT || 'ees-visitor-static-salt';
        return createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 32);
    }

    newId(): string { return randomUUID().replace(/-/g, ''); }
}

function isBot(ua: string): boolean {
    return /bot|crawl|spider|slurp|bingpreview|preview|http[-_]?client|fetch|axios|curl|wget|monitor|uptimerobot/i.test(ua);
}

function isLocalIp(ip: string): boolean {
    if (!ip) return true;
    if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.')
        || ip.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) {
        return true;
    }
    return false;
}

async function getMaxmindReader(): Promise<any | null> {
    if (_maxmindReader) return _maxmindReader;
    if (_maxmindInit) {
        await _maxmindInit;
        return _maxmindReader;
    }
    _maxmindInit = (async () => {
        try {
            const geolite2 = await import('geolite2-redist');
            const { Reader } = await import('@maxmind/geoip2-node');
            _maxmindReader = await (geolite2 as any).open('GeoLite2-City', (p: string) => (Reader as any).open(p));
        } catch (err: any) {
            // First-call cold start can fail if the DB isn't downloaded
            // yet — let the next call retry. Log once.
            Logger.warn(`MaxMind reader init failed: ${err?.message}`, 'VisitorTrackingService');
            _maxmindReader = null;
        }
    })();
    await _maxmindInit;
    _maxmindInit = null;
    return _maxmindReader;
}
