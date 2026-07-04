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
                `SELECT id, sessionId, visitorId, customerId, currency, totalMinor, itemCount,
                        email, status, abandonedAt, recoveredAt, notificationSent,
                        utmSource, utmMedium, countryCode
                 FROM abandoned_cart
                 ${clause}
                 ORDER BY abandonedAt DESC
                 LIMIT ? OFFSET ?`,
                [...params, take, skip],
            ),
            conn.query(`SELECT COUNT(*) AS c FROM abandoned_cart ${clause}`, params),
        ]);
        return {
            items: rows,
            total: Number(totalRow?.[0]?.c || 0),
            take, skip,
        };
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
        return { ...r, items };
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
