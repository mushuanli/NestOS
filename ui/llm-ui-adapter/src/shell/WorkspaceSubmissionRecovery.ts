import type {OperationLedger, OperationRecord} from '@itookit/llm-ui';
import {t} from '@itookit/common';
import type {SessionInstructionQueue, SubmissionRequest} from '@itookit/llm-session/contracts';

/** Reconcile frozen submissions without entering the composer, recompiling targets or sending input. */
export class WorkspaceSubmissionRecovery {
    private readonly element = document.createElement('div');
    private readonly busy = new Set<string>();
    private readonly release: () => void;
    private closed = false;
    private active = true;
    constructor(host: HTMLElement, private readonly ledger: OperationLedger, private readonly sessionId: string,
        private readonly reconcile: (id: string) => Promise<void>, private readonly onError: (error: unknown) => void) {
        this.element.className = 'llm-input__connection-notice'; this.element.dataset.callRecovery = '';
        this.element.setAttribute('role', 'status'); host.before(this.element);
        this.release = ledger.subscribe(() => this.render()); this.render();
    }
    setActive(active: boolean): void {this.active = active; if (active) this.render();}
    observe(queue?: SessionInstructionQueue): void {
        if (this.closed || !this.active || queue?.sessionId !== this.sessionId) return;
        for (const record of this.ledger.getSnapshot()) {
            if (record.kind !== 'send' || record.conversationId !== this.sessionId || !['unknown', 'submitting'].includes(record.status)) continue;
            const request = (record.input as {request?: SubmissionRequest})?.request, expected = request?.submission;
            if (expected && queue.items.some(item => item.id === expected.id && item.sendIntent?.submission?.source.kind === expected.source.kind
                && item.sendIntent.submission.source.ownerId === expected.source.ownerId && item.sendIntent.submission.source.id === expected.source.id))
                void this.run(record.context.operationId);
        }
    }
    dispose(): void {this.closed = true; this.release(); this.element.remove();}
    private render(): void {
        if (this.closed || !this.active) return;
        const records = this.ledger.getSnapshot().filter(record => record.kind === 'send' && record.conversationId === this.sessionId
            && ['submitting', 'unknown'].includes(record.status) && !!(record.input as {request?: unknown})?.request);
        this.element.hidden = !records.length; this.element.replaceChildren();
        for (const record of records) {
            const row = document.createElement('div'), button = document.createElement('button'); button.type = 'button';
            const id = record.context.operationId;
            row.append(this.label(record) + ' · ' + t(record.status === 'unknown' ? 'callable.submission.unknown' : 'chat.submission.submitting') + ' ');
            button.className = 'llm-btn'; button.dataset.callReconcile = id; button.disabled = this.busy.has(id);
            button.textContent = t(this.busy.has(id) ? 'callable.submission.checking' : 'callable.submission.reconcile');
            button.onclick = () => {void this.run(id);}; row.append(button); this.element.append(row);
        }
    }
    private label(record: OperationRecord): string {
        const request = (record.input as {request?: SubmissionRequest})?.request;
        const text = request?.presentation?.text ?? (request?.source.kind === 'composer' ? request.source.text : JSON.stringify(request?.source.value ?? {}));
        return [request?.target.id, text.replace(/\s+/g, ' ').slice(0, 80)].filter(Boolean).join(' · ');
    }
    private async run(id: string): Promise<void> {
        if (this.closed || !this.active || this.busy.has(id)) return;
        this.busy.add(id); this.render();
        try {await this.reconcile(id);} catch (error) {if (!this.closed && this.active) this.onError(error);}
        finally {this.busy.delete(id); this.render();}
    }
}
