import { describe, expect, it } from 'vitest';
import { getRealIp, getResolvedCountry, getResolvedRegion } from './proxy-headers';

const req = (headers: Record<string, string>, ip?: string): any => ({ headers, ip });

describe('getRealIp', () => {
    it('prefers CF-Connecting-IP above everything', () => {
        expect(getRealIp(req({
            'cf-connecting-ip': '1.1.1.1', 'true-client-ip': '2.2.2.2',
            'x-real-ip': '3.3.3.3', 'x-forwarded-for': '4.4.4.4',
        }, '5.5.5.5'))).toBe('1.1.1.1');
    });
    it('falls through the precedence chain', () => {
        expect(getRealIp(req({ 'true-client-ip': '2.2.2.2', 'x-real-ip': '3.3.3.3' }))).toBe('2.2.2.2');
        expect(getRealIp(req({ 'x-real-ip': '3.3.3.3' }))).toBe('3.3.3.3');
        expect(getRealIp(req({ 'x-forwarded-for': '4.4.4.4, 9.9.9.9' }))).toBe('4.4.4.4');
    });
    it('uses the left-most XFF entry', () => {
        expect(getRealIp(req({ 'x-forwarded-for': '  203.0.113.1 , 10.0.0.1 , 10.0.0.2 ' }))).toBe('203.0.113.1');
    });
    it('falls back to req.ip then null', () => {
        expect(getRealIp(req({}, '5.5.5.5'))).toBe('5.5.5.5');
        expect(getRealIp(req({}))).toBeNull();
    });
});

describe('getResolvedCountry', () => {
    it('reads cf-ipcountry', () => {
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'gb' }))).toBe('GB');
    });
    it('ignores CF placeholders XX and T1', () => {
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'XX' }))).toBeNull();
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'T1' }))).toBeNull();
    });
    it('parses Akamai edgescape', () => {
        expect(getResolvedCountry(req({ 'x-akamai-edgescape': 'georegion=246,country_code=US,region_code=CA' }))).toBe('US');
    });
    it('reads the Fastly country header', () => {
        expect(getResolvedCountry(req({ 'x-country-code': 'de' }))).toBe('DE');
        expect(getResolvedCountry(req({ 'x-country-code': 'not-a-code' }))).toBeNull();
    });
    it('returns null when nothing present', () => {
        expect(getResolvedCountry(req({}))).toBeNull();
    });
});

describe('getResolvedRegion', () => {
    it('reads cf-region-code', () => {
        expect(getResolvedRegion(req({ 'cf-region-code': 'eng' }))).toBe('ENG');
        expect(getResolvedRegion(req({ 'cf-region-code': 'CA' }))).toBe('CA');
    });
    it('rejects malformed region codes and empties', () => {
        expect(getResolvedRegion(req({ 'cf-region-code': 'TOOLONG' }))).toBeNull();
        expect(getResolvedRegion(req({}))).toBeNull();
    });
});
