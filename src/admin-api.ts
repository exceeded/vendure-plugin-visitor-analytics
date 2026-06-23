/**
 * Vendure Admin API extensions for HULO Visitor Analytics.
 *
 * Mirrors the operator queries from the REST controller — summary,
 * sources, top-pages, funnel, journey — so any GraphQL client can
 * drive the dashboards. The high-frequency public path POST /ees/track
 * stays REST: it's an anonymous beacon, ingests potentially millions
 * of events / day, and benefits from being outside the resolver stack.
 */
import { Injectable } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { gql } from 'graphql-tag';
import { Allow, Ctx, Permission, RequestContext, TransactionalConnection } from '@vendure/core';

export const visitorAnalyticsAdminApiSchema = gql`
    type HuloVisitorSummary {
        days: Int!
        channelId: Int
        visitors: Int!
        sessions: Int!
        pageViews: Int!
        events: Int!
        bounceRate: Float!
        avgSessionSec: Float!
    }

    type HuloVisitorSource {
        source: String!
        visitors: Int!
        sessions: Int!
    }

    type HuloVisitorPage {
        url: String!
        title: String
        views: Int!
        uniqueVisitors: Int!
        avgTimeOnPageSec: Float!
    }

    type HuloFunnelStep {
        index: Int!
        urlPattern: String!
        label: String
        users: Int!
        dropOffPct: Float!
    }

    type HuloVisitorFunnel {
        days: Int!
        steps: [HuloFunnelStep!]!
    }

    type HuloVisitorEvent {
        id: ID!
        createdAt: DateTime!
        type: String!
        url: String
        title: String
        referrerDomain: String
        country: String
        region: String
        city: String
        browser: String
        os: String
        device: String
        sessionId: String!
        visitorId: String!
        customerId: Int
    }

    input HuloVisitorFunnelInput {
        channelId: Int
        days: Int
        steps: [String!]!
    }

    extend type Query {
        huloVisitorSummary(channelId: Int, days: Int): HuloVisitorSummary!
        huloVisitorSources(channelId: Int, days: Int): [HuloVisitorSource!]!
        huloVisitorTopPages(channelId: Int, days: Int): [HuloVisitorPage!]!
        huloVisitorFunnel(input: HuloVisitorFunnelInput!): HuloVisitorFunnel!
        huloVisitorJourney(visitorId: String!): [HuloVisitorEvent!]!
    }
`;

function clampDays(input: any): number {
    return Math.min(Math.max(Number(input) || 7, 1), 365);
}
function channelFilter(channelId?: number): { where: string; params: any[] } {
    if (channelId) return { where: ' AND channelId = ?', params: [channelId] };
    return { where: '', params: [] };
}

@Resolver()
@Injectable()
export class VisitorAnalyticsAdminResolver {
    constructor(private connection: TransactionalConnection) {}

    @Query()
    @Allow(Permission.ReadCustomer)
    async huloVisitorSummary(
        @Ctx() ctx: RequestContext,
        @Args('channelId') channelId?: number,
        @Args('days') daysInput?: number,
    ): Promise<any> {
        const days = clampDays(daysInput);
        const c = channelFilter(channelId);
        const totals = await this.connection.rawConnection.query(
            `SELECT COUNT(DISTINCT visitorId) AS visitors,
                    COUNT(DISTINCT sessionId) AS sessions,
                    SUM(type = 'pageview') AS pageViews,
                    COUNT(*) AS events
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)${c.where}`,
            [days, ...c.params],
        );
        const t = (totals as any[])[0] || {};
        const sessionRows = await this.connection.rawConnection.query(
            `SELECT sessionId,
                    TIMESTAMPDIFF(SECOND, MIN(createdAt), MAX(createdAt)) AS dur,
                    COUNT(*) AS n
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)${c.where}
             GROUP BY sessionId`,
            [days, ...c.params],
        );
        const ssRows = sessionRows as any[];
        const bounces = ssRows.filter((s: any) => Number(s.n) <= 1).length;
        const avg = ssRows.length ? ssRows.reduce((a: number, s: any) => a + Number(s.dur || 0), 0) / ssRows.length : 0;
        return {
            days, channelId: channelId || null,
            visitors: Number(t.visitors) || 0,
            sessions: Number(t.sessions) || 0,
            pageViews: Number(t.pageViews) || 0,
            events: Number(t.events) || 0,
            bounceRate: ssRows.length ? bounces / ssRows.length : 0,
            avgSessionSec: avg,
        };
    }

    @Query()
    @Allow(Permission.ReadCustomer)
    async huloVisitorSources(@Args('channelId') channelId?: number, @Args('days') daysInput?: number): Promise<any[]> {
        const days = clampDays(daysInput);
        const c = channelFilter(channelId);
        const rows = await this.connection.rawConnection.query(
            `SELECT COALESCE(NULLIF(referrerDomain, ''), '(direct)') AS source,
                    COUNT(DISTINCT visitorId) AS visitors,
                    COUNT(DISTINCT sessionId) AS sessions
             FROM visitor_event
             WHERE createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)${c.where}
             GROUP BY source ORDER BY sessions DESC LIMIT 50`,
            [days, ...c.params],
        );
        return rows.map((r: any) => ({
            source: r.source,
            visitors: Number(r.visitors) || 0,
            sessions: Number(r.sessions) || 0,
        }));
    }

    @Query()
    @Allow(Permission.ReadCustomer)
    async huloVisitorTopPages(@Args('channelId') channelId?: number, @Args('days') daysInput?: number): Promise<any[]> {
        const days = clampDays(daysInput);
        const c = channelFilter(channelId);
        const rows = await this.connection.rawConnection.query(
            `SELECT url,
                    MAX(title) AS title,
                    COUNT(*) AS views,
                    COUNT(DISTINCT visitorId) AS uniqueVisitors,
                    AVG(COALESCE(timeOnPageMs, 0)) / 1000 AS avgTimeOnPageSec
             FROM visitor_event
             WHERE type = 'pageview'
               AND createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)${c.where}
             GROUP BY url ORDER BY views DESC LIMIT 50`,
            [days, ...c.params],
        );
        return rows.map((r: any) => ({
            url: r.url || '',
            title: r.title || null,
            views: Number(r.views) || 0,
            uniqueVisitors: Number(r.uniqueVisitors) || 0,
            avgTimeOnPageSec: Number(r.avgTimeOnPageSec) || 0,
        }));
    }

    @Query()
    @Allow(Permission.ReadCustomer)
    async huloVisitorFunnel(@Args('input') input: any): Promise<any> {
        const days = clampDays(input?.days);
        const c = channelFilter(input?.channelId);
        const steps: string[] = Array.isArray(input?.steps) ? input.steps.map(String) : [];
        if (!steps.length) return { days, steps: [] };
        // For each step, count distinct visitors who hit it. This is a
        // pageview-funnel approximation; ordered funnel (visitor must
        // have hit step i-1 before i) is a future enhancement.
        const out: any[] = [];
        let prevUsers: number | null = null;
        for (let i = 0; i < steps.length; i++) {
            const pattern = steps[i];
            const rows = await this.connection.rawConnection.query(
                `SELECT COUNT(DISTINCT visitorId) AS n
                 FROM visitor_event
                 WHERE type = 'pageview'
                   AND url LIKE ?
                   AND createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)${c.where}`,
                [pattern.replace(/\*/g, '%'), days, ...c.params],
            );
            const users = Number((rows as any[])[0]?.n) || 0;
            const dropOff = prevUsers && prevUsers > 0 ? 1 - (users / prevUsers) : 0;
            out.push({ index: i, urlPattern: pattern, label: null, users, dropOffPct: dropOff });
            prevUsers = users;
        }
        return { days, steps: out };
    }

    @Query()
    @Allow(Permission.ReadCustomer)
    async huloVisitorJourney(@Args('visitorId') visitorId: string): Promise<any[]> {
        if (!visitorId) return [];
        const rows = await this.connection.rawConnection.query(
            `SELECT id, createdAt, type, url, title, referrerDomain,
                    country, region, city, browser, os, device,
                    sessionId, visitorId, customerId
             FROM visitor_event
             WHERE visitorId = ?
             ORDER BY createdAt ASC LIMIT 1000`,
            [String(visitorId)],
        );
        return rows;
    }
}
