import {t} from '@itookit/common';
import type {ChatView, OperationLedger, OperationReceipt} from '@itookit/llm-ui';

/** Legacy requests from another draft scope stay queryable without consuming the current input. */
export function mountNativeRecovery(root: HTMLElement, operations: OperationLedger, view: () => ChatView | undefined,
    available: () => boolean, receipt: (id: string) => Promise<OperationReceipt>, report: (error: unknown) => void) {
    const panel = document.createElement('section'); panel.setAttribute('role', 'status'); root.append(panel);
    let closed = false; const pending = new Set<string>();
    const update = () => {
        if (closed) return; panel.replaceChildren();
        const scope = view()?.getDraft().scopeId;
        for (const record of operations.getSnapshot()) {
            if (!['submitting', 'unknown'].includes(record.status) || record.draft?.scopeId === scope
                || (record.input as {protocol?: string})?.protocol !== 'legacy-composer-v1') continue;
            const row = document.createElement('p'), query = document.createElement('button'); query.type = 'button';
            row.textContent = t('chat.submission.unconfirmed'); query.textContent = t('harness.reconcile');
            query.disabled = !available() || pending.has(record.context.operationId);
            query.onclick = () => {void reconcile(record.context.operationId).catch(report);}; row.append(query); panel.append(row);
        }
        panel.hidden = !panel.childNodes.length;
    };
    async function reconcile(id: string): Promise<void> {
        if (closed || !available() || pending.has(id)) return;
        pending.add(id); update();
        try {
            const result = await receipt(id);
            if (result.operationId !== id) throw new Error('Native recovery receipt identity mismatch');
            await operations.settle(result);
        } finally {pending.delete(id); update();}
    }
    const unsubscribe = operations.subscribe(update); update();
    return {update, destroy: () => {closed = true; unsubscribe(); panel.remove();}};
}
