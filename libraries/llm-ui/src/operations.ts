import type { OperationLedger, OperationReceipt, OperationRecord } from './contracts';

export interface OperationLedgerOptions {
    readonly initial?: readonly OperationRecord[];
    readonly save?: (records: readonly OperationRecord[]) => Promise<void>;
    readonly onError?: (error: unknown) => void;
}

/** Publish only saved immutable versions; action dispatch waits for registration. */
export function createOperationLedger(options: OperationLedgerOptions = {}): OperationLedger {
    let records: readonly OperationRecord[] = structuredClone(options.initial ?? []);
    let tail = Promise.resolve();
    const listeners = new Set<() => void>();
    const mutate = (change: () => readonly OperationRecord[]) => {
        const task = tail.catch(() => {}).then(async () => {
            const next = change();
            if (next === records) return;
            await options.save?.(next);
            records = next;
            for (const listener of listeners) {
                try { listener(); } catch (error) { options.onError?.(error); }
            }
        });
        tail = task;
        return task;
    };
    return {
        getSnapshot: () => records,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        register: record => mutate(() => {
            if (records.some(item => item.context.operationId === record.context.operationId)) throw new Error('Duplicate operation identity');
            return [...records, structuredClone(record)];
        }),
        settle: receipt => mutate(() => settle(records, receipt, options.onError)),
    };
}

function settle(records: readonly OperationRecord[], receipt: OperationReceipt,
    report?: (error: unknown) => void): readonly OperationRecord[] {
    const current = records.find(item => item.context.operationId === receipt.operationId);
    if (!current) throw new Error('Unknown operation identity');
    if (current.status === 'accepted' || current.status === 'rejected') {
        if (receipt.status !== 'unknown' && receipt.status !== current.status)
            report?.(new Error(`Conflicting receipt: ${receipt.operationId}`));
        if (current.status === 'accepted' && receipt.status === 'accepted' && receipt.observedUserMessageId && !current.observedUserMessageId)
            return records.map(item => item === current ? { ...item, observedUserMessageId: receipt.observedUserMessageId } : item);
        return records;
    }
    const next = { ...current, status: receipt.status, message: 'message' in receipt ? receipt.message : undefined,
        submissionRef: receipt.status === 'accepted' ? receipt.submissionRef : current.submissionRef,
        observedUserMessageId: receipt.status === 'accepted' ? receipt.observedUserMessageId : current.observedUserMessageId };
    return records.map(item => item === current ? next : item);
}
