import {t} from '@itookit/common';
import type {IndependentCallView, IndependentCallDescendant} from '@itookit/llm-session/contracts';
import type {CallControlOperations} from '../independent/call-control';
import {IndependentCallControl} from './IndependentCallControl';

interface Row {element: HTMLElement; label: HTMLElement; status: HTMLElement; control: IndependentCallControl}
/** View-only rows; cancellation identity and recovery remain in the shared ledger. */
export class IndependentCallDescendants {
    private rows = new Map<string, Row>();
    private active = true;
    private heading = document.createElement('summary');
    constructor(private element: HTMLElement, private controls: CallControlOperations, private refresh: () => void) {element.append(this.heading);}
    update(call: IndependentCallView): void {
        const items = new Map((call.descendants?.items ?? []).map(item => [item.taskId, item]));
        const root = call.receipt.execution?.taskId;
        const pending = root ? this.controls.pendingCancellationTargets(call.input.request.expectedBranch!, call.receipt.operationId, root) : [];
        const ids = new Set([...items.keys(), ...pending]);
        this.element.hidden = !ids.size;
        this.heading.textContent = t('callable.independent.descendants.heading', {shown: items.size, total: call.descendants?.total ?? 0})
            + (pending.length ? t('callable.independent.descendants.pending', {count: pending.length}) : '');
        for (const id of ids) this.updateRow(id, call, items.get(id));
        for (const [id, row] of this.rows) if (!ids.has(id)) {row.control.destroy(); row.element.remove(); this.rows.delete(id);}
    }
    setActive(active: boolean): void {this.active = active; for (const row of this.rows.values()) row.control.setActive(active);}
    destroy(): void {for (const row of this.rows.values()) row.control.destroy(); this.rows.clear(); this.element.replaceChildren();}
    private updateRow(id: string, call: IndependentCallView, item?: IndependentCallDescendant): void {
        let row = this.rows.get(id);
        if (!row) {
            const element = document.createElement('section'), label = document.createElement('strong'), status = document.createElement('p'), host = document.createElement('div');
            element.dataset.callDescendant = id; element.append(label, status, host);
            row = {element, label, status, control: new IndependentCallControl(host, this.controls, this.refresh, id)};
            row.control.setActive(this.active); this.rows.set(id, row); this.element.append(element);
        }
        row.label.textContent = t('callable.independent.descendants.task', {id});
        row.status.textContent = item ? t('callable.independent.descendants.state', {
            phase: t(`callable.independent.descendants.phase.${item.executionState.phase}`), count: item.executionState.activeOperations,
        }) : t('callable.independent.cancel.unknown');
        row.control.update(call, item);
    }
}
