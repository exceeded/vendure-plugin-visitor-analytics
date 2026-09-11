import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Pure helpers behind the cart-recovery attribution + opt-out features
 * (0.18.0). No I/O — everything here is unit-tested in isolation.
 */

/** Vendure order states from which a customer can still pick up the same
 *  order (the storefront can add items / arrange payment). Anything later —
 *  `PaymentAuthorized`, `PaymentSettled`, `Cancelled`, … — is a finished or
 *  dead order and the storefront should rebuild a fresh cart instead. */
export const RESUMABLE_ORDER_STATES: ReadonlyArray<string> = ['AddingItems', 'ArrangingPayment'];

export function isResumableOrderState(state: string | null | undefined): boolean {
    return !!state && RESUMABLE_ORDER_STATES.includes(String(state));
}

/**
 * Where a recovery link got to. Monotonic — a step never moves backwards,
 * so the admin can read a funnel straight off the column:
 *
 *   link_issued → link_opened → resumed → converted
 */
export type RecoveryStep = 'link_issued' | 'link_opened' | 'resumed' | 'converted';

const RECOVERY_STEP_ORDER: ReadonlyArray<RecoveryStep> = ['link_issued', 'link_opened', 'resumed', 'converted'];

export function recoveryStepRank(step: string | null | undefined): number {
    const i = RECOVERY_STEP_ORDER.indexOf(String(step || '') as RecoveryStep);
    return i;
}

/** Returns the later of `current` and `target`; never regresses. Unknown
 *  values in `current` (legacy rows, hand edits) are treated as "no step". */
export function advanceRecoveryStep(
    current: string | null | undefined,
    target: RecoveryStep,
): RecoveryStep {
    return recoveryStepRank(current) >= recoveryStepRank(target)
        ? (current as RecoveryStep)
        : target;
}

/** Lower-cased, trimmed. Returns '' for anything that is not an email. */
export function normaliseEmail(raw: string | null | undefined): string {
    const s = String(raw || '').trim().toLowerCase();
    if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
    return s;
}

/** SHA-256 hex of the normalised email — the same hash `abandoned_cart.emailHash`
 *  stores, so opt-outs can be matched without keeping the raw address. */
export function hashEmail(email: string): string {
    return createHash('sha256').update(normaliseEmail(email)).digest('hex');
}

function b64url(buf: Buffer): string {
    return buf.toString('base64url');
}

function optOutMac(email: string, secret: string): string {
    return b64url(createHmac('sha256', secret).update(`opt-out:${email}`).digest());
}

/**
 * Opt-out token: `<base64url(email)>.<base64url(hmac-sha256(secret, email))>`.
 * Self-describing so the endpoint needs no DB lookup to know *who* is opting
 * out, and unforgeable so a third party cannot unsubscribe someone else.
 * Returns null when there is no secret (feature disabled) or the email is
 * malformed.
 */
export function buildOptOutToken(email: string, secret: string): string | null {
    const e = normaliseEmail(email);
    if (!e || !secret) return null;
    return `${b64url(Buffer.from(e, 'utf8'))}.${optOutMac(e, secret)}`;
}

/** Inverse of `buildOptOutToken`. Returns the normalised email on success,
 *  null on any failure (bad shape, bad MAC, wrong secret). Constant-time
 *  MAC comparison. */
export function verifyOptOutToken(token: string | null | undefined, secret: string): string | null {
    if (!secret) return null;
    const t = String(token || '').trim();
    const dot = t.indexOf('.');
    if (dot <= 0 || dot === t.length - 1) return null;
    let email = '';
    try {
        email = normaliseEmail(Buffer.from(t.slice(0, dot), 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!email) return null;
    const expected = Buffer.from(optOutMac(email, secret));
    const given = Buffer.from(t.slice(dot + 1));
    if (expected.length !== given.length) return null;
    return timingSafeEqual(expected, given) ? email : null;
}

/** Build the absolute opt-out URL for an email. `backendBaseUrl` is the
 *  Vendure server's public origin (the endpoint lives on the API, not the
 *  storefront). */
export function buildOptOutUrl(backendBaseUrl: string, email: string, secret: string): string | null {
    const token = buildOptOutToken(email, secret);
    if (!token) return null;
    return `${String(backendBaseUrl || '').replace(/\/$/, '')}/ees/abandoned-carts/opt-out?e=${encodeURIComponent(token)}`;
}

/**
 * Headers a mailer should add to every abandoned-cart email so Gmail /
 * Outlook / Yahoo render their native "Unsubscribe" affordance
 * (RFC 2369 + RFC 8058 one-click). Returns null when opt-out links are
 * disabled.
 */
export function buildListUnsubscribeHeaders(
    backendBaseUrl: string,
    email: string,
    secret: string,
): { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string } | null {
    const url = buildOptOutUrl(backendBaseUrl, email, secret);
    if (!url) return null;
    return {
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
}

/** Order codes are Vendure-generated (16 upper-case alphanumerics by default)
 *  but hosts can override the generator, so accept a generous safe subset. */
export function sanitiseOrderCode(raw: string | null | undefined): string {
    const s = String(raw || '').trim();
    return /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : '';
}
