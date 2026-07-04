import { Controller, Get, Post, Query, Param, Req, Res, Body } from '@nestjs/common';
import { Ctx, RequestContext, Allow, Permission } from '@vendure/core';
import { Request, Response } from 'express';
import { AbandonedCartService } from './abandoned-cart.service';

/**
 * Admin API for the Abandoned Cart feature.
 *
 * Endpoints:
 *   GET  /ees/abandoned-carts                — paginated list with filters
 *   GET  /ees/abandoned-carts/summary        — totals + top-value + recovery rate
 *   GET  /ees/abandoned-carts/:id            — detail incl. parsed items
 *   POST /ees/abandoned-carts/:id/recovery-link  — mint/reissue signed URL
 *   POST /ees/abandoned-carts/:id/status     — mark recovered/dismissed
 *   GET  /ees/abandoned-carts/export.csv     — CSV export
 *
 * Storefront-side (unauthenticated):
 *   GET  /ees/recover-cart?t=...             — resolve a token → items
 */
@Controller('ees')
export class AbandonedCartController {
    constructor(private readonly service: AbandonedCartService) {}

    @Get('abandoned-carts')
    @Allow(Permission.ReadCustomer)
    async list(
        @Ctx() ctx: RequestContext,
        @Query('take') takeRaw?: string,
        @Query('skip') skipRaw?: string,
        @Query('status') status?: string,
        @Query('minValue') minValueRaw?: string,
        @Query('email') email?: string,
    ) {
        const take = Math.min(Math.max(1, parseInt(takeRaw || '25', 10) || 25), 200);
        const skip = Math.max(0, parseInt(skipRaw || '0', 10) || 0);
        const where: string[] = [];
        const params: any[] = [];
        if (status) { where.push('status = ?'); params.push(status); }
        if (minValueRaw) {
            const v = parseInt(minValueRaw, 10);
            if (Number.isFinite(v)) { where.push('totalMinor >= ?'); params.push(v); }
        }
        if (email) {
            where.push('LOWER(email) LIKE ?');
            params.push(`%${email.toLowerCase()}%`);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const conn = (this.service as any).connection.rawConnection;
        const [rows, totalRow] = await Promise.all([
            conn.query(
                // itemsJson included so the list can render a preview of the
                // first few item names alongside the count. Slightly heavier
                // than the previous SELECT but capped by LIMIT and paginated,
                // so the payload growth stays proportional to the page size.
                `SELECT id, sessionId, visitorId, customerId, currency, totalMinor, itemCount,
                        itemsJson, email, status, abandonedAt, recoveredAt, notificationSent,
                        utmSource, utmMedium, countryCode
                 FROM abandoned_cart
                 ${clause}
                 ORDER BY abandonedAt DESC
                 LIMIT ? OFFSET ?`,
                [...params, take, skip],
            ),
            conn.query(`SELECT COUNT(*) AS c FROM abandoned_cart ${clause}`, params),
        ]);
        // Enrich each row with:
        //   - items: parsed array (never null; empty array if malformed)
        //   - itemsPreview: short human-readable summary
        //     ("Windows 11 Pro, Office 2021 +1 more")
        // The preview is a rendering aid — sorted by qty desc so the
        // biggest lines lead, truncated at 3 names + "+N more".
        for (const r of rows) {
            let items: any[] = [];
            try { items = JSON.parse(r.itemsJson || '[]'); } catch {}
            r.items = items;
            r.itemsPreview = this.buildItemsPreview(items);
            // Drop the raw JSON blob from the list response so the payload
            // stays lean — clients that need it can hit the detail endpoint.
            delete r.itemsJson;
        }
        return {
            items: rows,
            total: Number(totalRow?.[0]?.c || 0),
            take, skip,
        };
    }

    /** Short human summary of a parsed itemsJson array. */
    private buildItemsPreview(items: any[]): string {
        if (!Array.isArray(items) || !items.length) return '';
        // Sort a shallow copy so we don't mutate the response body.
        const sorted = [...items].sort(
            (a, b) => Number(b?.qty || 0) - Number(a?.qty || 0),
        );
        const named = sorted
            .map(i => String(i?.name || '').trim())
            .filter(Boolean);
        if (!named.length) return `${items.length} item(s)`;
        const head = named.slice(0, 3).join(', ');
        const remaining = named.length - 3;
        return remaining > 0 ? `${head} +${remaining} more` : head;
    }

    @Get('abandoned-carts/summary')
    @Allow(Permission.ReadCustomer)
    async summary(@Ctx() ctx: RequestContext, @Query('days') daysRaw?: string) {
        const days = Math.min(Math.max(1, parseInt(daysRaw || '30', 10) || 30), 365);
        const since = new Date(Date.now() - days * 86400_000);
        const conn = (this.service as any).connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT
                COUNT(*) AS total,
                SUM(status = 'abandoned') AS openCount,
                SUM(status = 'recovered') AS recoveredCount,
                SUM(status = 'converted') AS convertedCount,
                SUM(status = 'expired')   AS expiredCount,
                SUM(status = 'dismissed') AS dismissedCount,
                SUM(totalMinor) AS totalValueMinor,
                SUM(CASE WHEN status IN ('recovered','converted') THEN totalMinor ELSE 0 END) AS recoveredValueMinor,
                AVG(totalMinor) AS avgValueMinor
             FROM abandoned_cart
             WHERE abandonedAt >= ?`,
            [since],
        );
        const s = rows?.[0] || {};
        const total = Number(s.total || 0);
        const rec = Number(s.recoveredCount || 0) + Number(s.convertedCount || 0);
        return {
            windowDays: days,
            total,
            openCount: Number(s.openCount || 0),
            recoveredCount: Number(s.recoveredCount || 0),
            convertedCount: Number(s.convertedCount || 0),
            expiredCount: Number(s.expiredCount || 0),
            dismissedCount: Number(s.dismissedCount || 0),
            recoveryRatePct: total ? Math.round((rec / total) * 1000) / 10 : 0,
            totalValueMinor: Number(s.totalValueMinor || 0),
            recoveredValueMinor: Number(s.recoveredValueMinor || 0),
            avgValueMinor: Math.round(Number(s.avgValueMinor || 0)),
        };
    }

    @Get('abandoned-carts/export.csv')
    @Allow(Permission.ReadCustomer)
    async exportCsv(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('days') daysRaw?: string) {
        const days = Math.min(Math.max(1, parseInt(daysRaw || '30', 10) || 30), 365);
        const since = new Date(Date.now() - days * 86400_000);
        const conn = (this.service as any).connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT id, sessionId, visitorId, customerId, currency, totalMinor, itemCount,
                    email, status, abandonedAt, recoveredAt, utmSource, utmMedium, utmCampaign, countryCode
             FROM abandoned_cart
             WHERE abandonedAt >= ?
             ORDER BY abandonedAt DESC
             LIMIT 50000`,
            [since],
        );
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition',
            `attachment; filename="abandoned-carts-${new Date().toISOString().slice(0,10)}.csv"`);
        const esc = (v: any) => {
            const s = v == null ? '' : String(v);
            return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const cols = ['id','sessionId','visitorId','customerId','currency','totalMinor','itemCount',
                      'email','status','abandonedAt','recoveredAt','utmSource','utmMedium','utmCampaign','countryCode'];
        res.write(cols.join(',') + '\n');
        for (const r of rows) {
            res.write(cols.map(c => esc(r[c])).join(',') + '\n');
        }
        res.end();
    }

    @Get('abandoned-carts/:id')
    @Allow(Permission.ReadCustomer)
    async detail(@Ctx() ctx: RequestContext, @Param('id') idRaw: string) {
        const id = parseInt(idRaw, 10);
        const conn = (this.service as any).connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT * FROM abandoned_cart WHERE id = ? LIMIT 1`,
            [id],
        );
        if (!rows?.length) return { error: 'not-found' };
        const r = rows[0];
        let items: any[] = [];
        try { items = JSON.parse(r.itemsJson || '[]'); } catch {}
        // Fill in missing product/variant names by looking them up in
        // Vendure. The storefront snapshot usually captures `name`
        // already; this is a fallback for older data, snapshots taken
        // before the product had a translation, or third-party
        // integrations that fire cart_snapshot without a name field.
        const enrichedItems = await this.enrichItemsWithNames(items);
        return {
            ...r,
            items: enrichedItems,
            itemsPreview: this.buildItemsPreview(enrichedItems),
        };
    }

    /**
     * Fill in missing `name` (and, when possible, `productId`) on each
     * cart item by looking up the variant / product from Vendure.
     * Untouched if the item already has a name — the storefront's
     * snapshot at cart time is usually more accurate than a live
     * catalog lookup (a name in Vendure may have changed since the
     * cart was abandoned).
     */
    private async enrichItemsWithNames(items: any[]): Promise<any[]> {
        if (!Array.isArray(items) || !items.length) return items || [];
        const conn = (this.service as any).connection.rawConnection;
        const variantIds = new Set<number>();
        const productIds = new Set<number>();
        for (const it of items) {
            if (it?.name) continue;
            const vid = Number(it?.variantId);
            const pid = Number(it?.productId);
            if (Number.isFinite(vid) && vid > 0) variantIds.add(vid);
            if (Number.isFinite(pid) && pid > 0) productIds.add(pid);
        }
        const variantNames = new Map<number, { name: string; productId: number }>();
        const productNames = new Map<number, string>();
        if (variantIds.size) {
            try {
                const vids = Array.from(variantIds);
                const ph = vids.map(() => '?').join(',');
                const rows: any[] = await conn.query(
                    `SELECT pv.id AS variantId, pv.productId AS productId, pvt.name AS name
                     FROM product_variant pv
                     LEFT JOIN product_variant_translation pvt ON pvt.baseId = pv.id
                     WHERE pv.id IN (${ph})
                     ORDER BY pv.id, pvt.languageCode = 'en' DESC`,
                    vids,
                );
                for (const row of rows) {
                    const vid = Number(row.variantId);
                    if (variantNames.has(vid)) continue;
                    variantNames.set(vid, {
                        name: String(row.name || ''),
                        productId: Number(row.productId),
                    });
                }
            } catch { /* fail-open */ }
        }
        if (productIds.size) {
            try {
                const pids = Array.from(productIds);
                const ph = pids.map(() => '?').join(',');
                const rows: any[] = await conn.query(
                    `SELECT baseId AS productId, name FROM product_translation
                     WHERE baseId IN (${ph})
                     ORDER BY baseId, languageCode = 'en' DESC`,
                    pids,
                );
                for (const row of rows) {
                    const pid = Number(row.productId);
                    if (productNames.has(pid)) continue;
                    productNames.set(pid, String(row.name || ''));
                }
            } catch { /* fail-open */ }
        }
        return items.map(it => {
            if (it?.name) return it;
            const vid = Number(it?.variantId);
            const vinfo = variantNames.get(vid);
            if (vinfo?.name) {
                return {
                    ...it,
                    name: vinfo.name,
                    productId: it.productId || vinfo.productId,
                };
            }
            const pid = Number(it?.productId);
            const pname = productNames.get(pid);
            if (pname) return { ...it, name: pname };
            return it;
        });
    }

    @Post('abandoned-carts/:id/recovery-link')
    @Allow(Permission.UpdateCustomer)
    async issueRecoveryLink(@Ctx() ctx: RequestContext, @Param('id') idRaw: string) {
        const id = parseInt(idRaw, 10);
        const url = await this.service.issueRecoveryLink(id);
        if (!url) return { error: 'recovery-disabled-or-not-found', hint: 'Set abandonment.recoveryLinkSecret in plugin options' };
        return { ok: true, url };
    }

    @Post('abandoned-carts/:id/status')
    @Allow(Permission.UpdateCustomer)
    async setStatus(
        @Ctx() ctx: RequestContext,
        @Param('id') idRaw: string,
        @Body() body: { status?: string },
    ) {
        const id = parseInt(idRaw, 10);
        const status = String(body?.status || '') as any;
        if (!['recovered', 'dismissed', 'abandoned'].includes(status)) {
            return { error: 'invalid-status' };
        }
        const ok = await this.service.markStatus(id, status as any);
        return ok ? { ok: true } : { error: 'not-found' };
    }

    /**
     * Public storefront endpoint — decodes a recovery token into a set
     * of cart items the storefront can restore. Rate-limited by the
     * plugin's usual ingest limiter (same origin as the tracker).
     */
    @Get('recover-cart')
    async recover(@Req() req: Request, @Query('t') token?: string) {
        const t = String(token || '').trim();
        if (!t) return { error: 'missing-token' };
        const result = await this.service.findByRecoveryToken(t);
        if (!result) return { error: 'expired-or-invalid' };
        return { ok: true, ...result };
    }
}
