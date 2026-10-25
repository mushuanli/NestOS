import {createModuleLogger, t} from '@itookit/common';
import {IndependentCallCommand, type IndependentCallView, type IndependentCallDescendant, type IndependentCallDescendantPage, type IndependentCallDescendantsResult, type ICommandBus} from '@itookit/llm-session/contracts';
import type {CallControlOperations} from '../independent/call-control';
import {assertDescendantPage} from '../independent/descendant-page';
import {callControlErrorCode} from '../independent/call-control';
import {IndependentCallControl} from './IndependentCallControl';

const log = createModuleLogger('independent-call-descendants');
interface Row {element: HTMLElement; label: HTMLElement; status: HTMLElement; control: IndependentCallControl}
/** View-only rows; cancellation identity and recovery remain in the shared ledger. */
export class IndependentCallDescendants {
    private rows = new Map<string, Row>();
    private active = true;
    private heading = document.createElement('summary');
    private first = document.createElement('button');
    private next = document.createElement('button');
    private error = document.createElement('p');
    private call?: IndependentCallView;
    private after?: string;
    private page?: IndependentCallDescendantPage;
    private generation = 0;
    private reading = false;
    private closed = false;
    private toggle = () => {if ((this.element as HTMLDetailsElement).open) void this.load();};
    constructor(private element: HTMLElement, private controls: CallControlOperations, private refresh: () => void, private commands: ICommandBus) {
        this.first.type = this.next.type = 'button'; this.first.dataset.callDescendantsFirst = ''; this.next.dataset.callDescendantsNext = '';
        this.first.textContent = t('callable.independent.descendants.first'); this.next.textContent = t('callable.independent.descendants.next');
        this.error.setAttribute('role', 'alert'); element.append(this.heading, this.first, this.next, this.error);
        this.element.addEventListener('toggle', this.toggle);
        this.first.onclick = () => this.navigate(); this.next.onclick = () => this.navigate(this.currentPage()?.nextAfterTaskId);
    }
    update(call: IndependentCallView): void {this.call = call; this.render(); if (this.after && this.active && (this.element as HTMLDetailsElement).open) void this.load();}
    setActive(active: boolean): void {
        this.active = active; ++this.generation; this.reading = false;
        for (const row of this.rows.values()) row.control.setActive(active);
        this.render();
    }
    destroy(): void {
        this.closed = true; this.element.removeEventListener('toggle', this.toggle); this.setActive(false); this.clear(); this.first.onclick = this.next.onclick = null; this.element.replaceChildren();
    }
    private currentPage(): IndependentCallDescendantPage | undefined {return this.after ? this.page : this.call?.descendants;}
    private navigate(after?: string): void {
        if (!this.active || this.closed) return;
        ++this.generation; this.after = after; this.page = undefined; this.reading = false; this.error.textContent = ''; this.clear(); this.render();
        if (after) void this.load(); else this.refresh();
    }
    private clear(): void {for (const row of this.rows.values()) {row.control.destroy(); row.element.remove();} this.rows.clear();}
    private render(): void {
        const call = this.call; if (!call || this.closed) return;
        const page = this.currentPage(), items = new Map((page?.items ?? []).map(item => [item.taskId, item]));
        const root = call.receipt.execution?.taskId;
        const pending = root ? this.controls.pendingCancellationTargets(call.input.request.expectedBranch!, call.receipt.operationId, root) : [];
        const ids = new Set([...items.keys(), ...pending]);
        this.element.hidden = !ids.size && !this.after && !this.error.textContent;
        this.heading.textContent = t('callable.independent.descendants.heading', {shown: items.size, total: page?.total ?? call.descendants?.total ?? 0})
            + (pending.length ? t('callable.independent.descendants.pending', {count: pending.length}) : '');
        this.first.hidden = !this.after; this.first.disabled = !this.active;
        this.next.hidden = !page?.nextAfterTaskId; this.next.disabled = !this.active || this.reading;
        for (const id of ids) this.updateRow(id, call, items.get(id));
        for (const [id, row] of this.rows) if (!ids.has(id)) {row.control.destroy(); row.element.remove(); this.rows.delete(id);}
    }
    private async load(): Promise<void> {
        const call = this.call, afterTaskId = this.after;
        if (!call?.receipt.execution || !afterTaskId || !this.active || this.closed || this.reading) return;
        const generation = this.generation, started = Date.now(); this.reading = true; this.render();
        const current = () => !this.closed && this.active && this.generation === generation;
        const query = {sessionId: call.receipt.callerSessionId, branchId: call.input.request.expectedBranch!, callId: call.receipt.operationId,
            executionSessionId: call.receipt.executionSessionId!, taskId: call.receipt.execution.taskId, afterTaskId};
        try {
            const result = await this.commands.execute<IndependentCallDescendantsResult>(IndependentCallCommand.Descendants, query);
            if (!current()) return;
            if (!result || Object.entries(query).some(([key, value]) => result[key as keyof typeof query] !== value)
                || !Number.isSafeInteger(result.asOfSequence) || result.asOfSequence < 0) throw Object.assign(new Error('CALL_VIEW_SCOPE_MISMATCH'), {code: 'CALL_VIEW_SCOPE_MISMATCH'});
            assertDescendantPage(result.descendants, query.taskId, afterTaskId);
            this.page = result.descendants; this.error.textContent = '';
            this.diagnose(call, started);
        } catch (error) {
            if (!current()) return;
            const code = callControlErrorCode(error); this.page = undefined; this.error.textContent = t('callable.independent.readFailed', {code});
            this.diagnose(call, started, code);
        } finally {if (current()) {this.reading = false; this.render();}}
    }
    private diagnose(call: IndependentCallView, started: number, code?: string): void {
        const id = call.receipt.operationId, operationId = /^[\w:-]{1,256}$/.test(id) ? id : undefined;
        const detail = {operationId, stage: 'descendants-page', result: code ? 'failure' : 'observed', code, durationMs: Date.now() - started};
        try {if (code) log.warn('call.descendants', detail); else log.debug('call.descendants', detail);}
        catch { /* Diagnostics must not change a page observation. */ }
    }
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
