import { describe, expect, it } from 'vitest';
import { anonymizeIp, isBotUa } from './detect-bot';

describe('isBotUa', () => {
    it('flags well-known crawlers and tools', () => {
        for (const ua of [
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Mozilla/5.0 (compatible; bingbot/2.0)',
            'facebookexternalhit/1.1',
            'Slackbot-LinkExpanding 1.0',
            'curl/8.4.0',
            'python-requests/2.31.0',
            'axios/1.6.0',
            'Go-http-client/2.0',
            'Mozilla/5.0 HeadlessChrome/120.0',
            'UptimeRobot/2.0',
        ]) {
            expect(isBotUa(ua), ua).toBe(true);
        }
    });

    it('passes real browser UAs', () => {
        for (const ua of [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0',
        ]) {
            expect(isBotUa(ua), ua).toBe(false);
        }
    });

    it('handles null / empty', () => {
        expect(isBotUa(null)).toBe(false);
        expect(isBotUa(undefined)).toBe(false);
        expect(isBotUa('')).toBe(false);
    });
});

describe('anonymizeIp', () => {
    it('zeroes the last octet of IPv4', () => {
        expect(anonymizeIp('203.0.113.42')).toBe('203.0.113.0');
        expect(anonymizeIp('10.1.2.3')).toBe('10.1.2.0');
    });

    it('keeps the first three hextets of IPv6', () => {
        expect(anonymizeIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::');
    });

    it('passes through unexpected shapes unchanged', () => {
        expect(anonymizeIp('fe80::1')).toBe('fe80::1'); // < 3 hextets
        expect(anonymizeIp('not-an-ip')).toBe('not-an-ip');
    });

    it('returns null for null input', () => {
        expect(anonymizeIp(null)).toBeNull();
    });
});
