import { NgModule } from '@angular/core';
import { SharedModule, addNavMenuItem, registerDashboardWidget } from '@vendure/admin-ui/core';

/**
 * Shared (eagerly loaded) module: the "Visitor Analytics" entry in the
 * admin nav under Marketing, and the dashboard widget
 * (Dashboard → Add widget → Visitor Analytics).
 */
@NgModule({
    imports: [SharedModule],
    providers: [
        addNavMenuItem(
            {
                id: 'hulo-vendure-plugin-visitor-analytics',
                label: 'Visitor Analytics',
                routerLink: ['/extensions/visitors'],
                icon: 'line-chart',
                requiresPermission: 'ReadCustomer',
            },
            'marketing',
        ),
        registerDashboardWidget('hulo-vendure-plugin-visitor-analytics', {
            title: 'Visitor Analytics',
            supportedWidths: [4, 6, 8],
            requiresPermissions: ['ReadCustomer'],
            loadComponent: () => import('./components/visitors-widget.component').then(m => m.VisitorsWidgetComponent),
        }),
    ],
})
export class VisitorsNavModule {}
