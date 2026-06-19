import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { VisitorsComponent } from './components/visitors.component';

@NgModule({
    imports: [
        SharedModule, FormsModule, HttpClientModule,
        RouterModule.forChild([
            { path: '', pathMatch: 'full', component: VisitorsComponent, data: { breadcrumb: 'Visitors' } },
        ]),
    ],
    declarations: [VisitorsComponent],
})
export class VisitorsModule {}
