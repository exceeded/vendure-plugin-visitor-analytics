import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SharedModule } from '@vendure/admin-ui/core';

interface WidgetData {
    tier: 'paid' | 'trial' | 'free';
    notice: { kind: string; message: string; daysLeft: number } | null;
    stats: Array<{ label: string; value: string }>;
    route: string;
}

/** Dashboard widget: three 7-day figures, the licence notice when there
 *  is one, and a link to the full page. Same cookie-authenticated
 *  `/ees/...` calls as the main component. */
@Component({
    selector: 'hulo-visitors-widget',
    standalone: true,
    imports: [SharedModule],
    template: `
        <div class="hulo-widget">
            <div class="stats" *ngIf="data">
                <div class="stat" *ngFor="let s of data.stats">
                    <div class="value">{{ s.value }}</div>
                    <div class="label">{{ s.label }}</div>
                </div>
            </div>
            <div class="notice" *ngIf="data?.notice?.message">{{ data?.notice?.message }}</div>
            <div class="muted" *ngIf="!data && !error">Loading…</div>
            <div class="muted" *ngIf="error">Could not load visitor stats.</div>
            <a class="open" [routerLink]="[data?.route || '/extensions/visitors']">Open Visitor Analytics →</a>
        </div>
    `,
    styles: [`
        .hulo-widget { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
        .stat { padding: 10px 12px; border-radius: 10px; background: var(--color-component-bg-200, #f8fafc); }
        .value { font-size: 24px; font-weight: 700; line-height: 1.1; color: var(--color-text-100, #0f172a); font-variant-numeric: tabular-nums; }
        .label { margin-top: 4px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--color-component-color-300, #64748b); }
        .notice { padding: 8px 12px; border-radius: 8px; background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; font-size: 12.5px; }
        .muted { color: var(--color-component-color-300, #64748b); font-size: 13px; }
        .open { font-weight: 600; font-size: 13px; }
    `],
})
export class VisitorsWidgetComponent implements OnInit {
    data: WidgetData | null = null;
    error = false;

    constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

    ngOnInit(): void {
        this.http.get<WidgetData>('/ees/widget').subscribe({
            next: d => { this.data = d; this.cdr.markForCheck(); },
            error: () => { this.error = true; this.cdr.markForCheck(); },
        });
    }
}
