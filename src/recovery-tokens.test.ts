import { describe, expect, it } from 'vitest';
import {
    advanceRecoveryStep,
    buildListUnsubscribeHeaders,
    buildOptOutToken,
    buildOptOutUrl,
    hashEmail,
    isResumableOrderState,
    normaliseEmail,
    recoveryStepRank,
    sanitiseOrderCode,
    verifyOptOutToken,
} from './recovery-tokens';

const SECRET = 'unit-test-secret-do-not-use';

describe('isResumableOrderState', () => {
    it('accepts the two open states only', () => {
        expect(isResumableOrderState('AddingItems')).toBe(true);
        expect(isResumableOrderState('ArrangingPayment')).toBe(true);
        expect(isResumableOrderState('PaymentAuthorized')).toBe(false);
        expect(isResumableOrderState('PaymentSettled')).toBe(false);
        expect(isResumableOrderState('Cancelled')).toBe(false);
        expect(isResumableOrderState('')).toBe(false);
        expect(isResumableOrderState(null)).toBe(false);
        expect(isResumableOrderState(undefined)).toBe(false);
    });
});

describe('recovery step lifecycle', () => {
    it('ranks the steps in funnel order', () => {
        expect(recoveryStepRank('link_issued')).toBeLessThan(recoveryStepRank('link_opened'));
        expect(recoveryStepRank('link_opened')).toBeLessThan(recoveryStepRank('resumed'));
        expect(recoveryStepRank('resumed')).toBeLessThan(recoveryStepRank('converted'));
        expect(recoveryStepRank(null)).toBe(-1);
        expect(recoveryStepRank('garbage')).toBe(-1);
    });
    it('advances forward', () => {
        expect(advanceRecoveryStep(null, 'link_issued')).toBe('link_issued');
        expect(advanceRecoveryStep('link_issued', 'link_opened')).toBe('link_opened');
        expect(advanceRecoveryStep('link_opened', 'converted')).toBe('converted');
    });
    it('never regresses', () => {
        expect(advanceRecoveryStep('converted', 'link_issued')).toBe('converted');
        expect(advanceRecoveryStep('resumed', 'link_opened')).toBe('resumed');
        expect(advanceRecoveryStep('link_opened', 'link_opened')).toBe('link_opened');
    });
    it('treats unknown current values as no step', () => {
        expect(advanceRecoveryStep('legacy-value', 'link_opened')).toBe('link_opened');
    });
});

describe('normaliseEmail / hashEmail', () => {
    it('lower-cases and trims', () => {
        expect(normaliseEmail('  Buyer@Example.COM ')).toBe('buyer@example.com');
    });
    it('rejects non-emails', () => {
        expect(normaliseEmail('not an email')).toBe('');
        expect(normaliseEmail('')).toBe('');
        expect(normaliseEmail(null)).toBe('');
        expect(normaliseEmail('a@b')).toBe('');
    });
    it('hashes the normalised form so case differences collapse', () => {
        expect(hashEmail('Buyer@Example.com')).toBe(hashEmail('buyer@example.com'));
        expect(hashEmail('buyer@example.com')).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('opt-out tokens', () => {
    it('round-trips', () => {
        const token = buildOptOutToken('Buyer@Example.com', SECRET);
        expect(token).toBeTruthy();
        expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(verifyOptOutToken(token, SECRET)).toBe('buyer@example.com');
    });
    it('is disabled without a secret', () => {
        expect(buildOptOutToken('buyer@example.com', '')).toBeNull();
        expect(verifyOptOutToken('anything.anything', '')).toBeNull();
    });
    it('refuses malformed emails', () => {
        expect(buildOptOutToken('nope', SECRET)).toBeNull();
    });
    it('rejects a tampered email part', () => {
        const token = buildOptOutToken('buyer@example.com', SECRET)!;
        const [, mac] = token.split('.');
        const forged = `${Buffer.from('victim@example.com').toString('base64url')}.${mac}`;
        expect(verifyOptOutToken(forged, SECRET)).toBeNull();
    });
    it('rejects a tampered MAC and a different secret', () => {
        const token = buildOptOutToken('buyer@example.com', SECRET)!;
        const [email, mac] = token.split('.');
        const flipped = mac[0] === 'A' ? 'B' : 'A';
        expect(verifyOptOutToken(`${email}.${flipped}${mac.slice(1)}`, SECRET)).toBeNull();
        expect(verifyOptOutToken(token, 'other-secret')).toBeNull();
    });
    it('rejects junk shapes', () => {
        expect(verifyOptOutToken('', SECRET)).toBeNull();
        expect(verifyOptOutToken('no-dot', SECRET)).toBeNull();
        expect(verifyOptOutToken('.mac', SECRET)).toBeNull();
        expect(verifyOptOutToken('email.', SECRET)).toBeNull();
        expect(verifyOptOutToken(null, SECRET)).toBeNull();
        expect(verifyOptOutToken(undefined, SECRET)).toBeNull();
    });
    it('builds an absolute URL on the backend origin', () => {
        const url = buildOptOutUrl('https://api.example.com/', 'buyer@example.com', SECRET)!;
        expect(url.startsWith('https://api.example.com/ees/abandoned-carts/opt-out?e=')).toBe(true);
        const e = new URL(url).searchParams.get('e');
        expect(verifyOptOutToken(e, SECRET)).toBe('buyer@example.com');
    });
    it('produces RFC 8058 headers', () => {
        const h = buildListUnsubscribeHeaders('https://api.example.com', 'buyer@example.com', SECRET)!;
        expect(h['List-Unsubscribe']).toMatch(/^<https:\/\/api\.example\.com\/ees\/abandoned-carts\/opt-out\?e=.+>$/);
        expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
        expect(buildListUnsubscribeHeaders('https://api.example.com', 'buyer@example.com', '')).toBeNull();
    });
});

describe('sanitiseOrderCode', () => {
    it('accepts Vendure-style codes', () => {
        expect(sanitiseOrderCode('S2BZ54TEKQWERTYU')).toBe('S2BZ54TEKQWERTYU');
        expect(sanitiseOrderCode('  abc-123_x ')).toBe('abc-123_x');
    });
    it('rejects anything else', () => {
        expect(sanitiseOrderCode('')).toBe('');
        expect(sanitiseOrderCode('abc')).toBe('');
        expect(sanitiseOrderCode("S2B'; DROP TABLE")).toBe('');
        expect(sanitiseOrderCode(null)).toBe('');
    });
});
