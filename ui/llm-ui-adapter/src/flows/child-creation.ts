import {createModuleLogger} from '@itookit/common';
import {ContentTransferCommand, type ChildCreationReceipt, type CreateChildInput, type ICommandBus} from '@itookit/llm-session/contracts';
const logger = createModuleLogger('child-creation');
/** Reconcile only the original creation; a reserved identity cannot stand in for completed preparation. */
export async function createChildWithReceipt(commands: ICommandBus, supplied: CreateChildInput, signal?: AbortSignal): Promise<{sessionId: string}> {
    const input = structuredClone(supplied), started = Date.now(); signal?.throwIfAborted();
    try {
        const result = await commands.execute<{sessionId: string}>(ContentTransferCommand.CreateChild, input);
        signal?.throwIfAborted();
        if (!validSessionId(result?.sessionId)) throw failure('CONTENT_CHILD_RESULT_INVALID');
        diagnostic(input, 'create', 'created', started); return {sessionId: result.sessionId};
    } catch (original) {
        signal?.throwIfAborted(); diagnostic(input, 'create', 'unknown', started, original);
        let receipt: ChildCreationReceipt;
        try {receipt = await commands.execute<ChildCreationReceipt>(ContentTransferCommand.ChildReceipt, input);}
        catch (error) {diagnostic(input, 'receipt', 'failure', started, error); throw original;}
        signal?.throwIfAborted();
        if (!validReceipt(receipt, input)) {
            const error = failure('CONTENT_CHILD_RECEIPT_MISMATCH'); diagnostic(input, 'receipt', 'failure', started, error); throw error;
        }
        diagnostic(input, 'receipt', receipt.status, started);
        if (receipt.status === 'created') return {sessionId: receipt.sessionId};
        throw original;
    }
}
function validSessionId(value: unknown): value is string {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value);}
function validReceipt(receipt: ChildCreationReceipt, input: CreateChildInput): boolean {
    return !!receipt && receipt.parentSessionId === input.sessionId && receipt.requestId === input.requestId
        && (receipt.status === 'unknown' || ['reserved', 'created'].includes(receipt.status) && validSessionId(receipt.sessionId));
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function diagnostic(input: CreateChildInput, stage: string, outcome: string, started: number, error?: unknown): void {
    const raw = (error as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : error ? 'CONTENT_CHILD_FAILED' : undefined;
    const detail = {operation: 'content.child.create', operationId: input.requestId, sessionId: input.sessionId, stage, outcome, code, durationMs: Date.now() - started};
    try {if (error) logger.warn('Child creation', detail); else logger.info('Child creation', detail);}
    catch { /* Diagnostics do not determine whether creation was committed. */ }
}
