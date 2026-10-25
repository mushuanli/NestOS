import type { HarnessMutationOptions } from '@itookit/mindos-node-driver';
import type { HarnessExecutionRequest, HarnessInlineAttachment } from '@itookit/kernel-adapters/contracts';
import type { HarnessConnectionAcquisition } from './harness-connections';
import { ExecutionJournal, executionError, jsonValue, nativeOperationId, type NativeOperation } from './harness-execution-journal';

export interface NativeExecution {
    attachments?: HarnessInlineAttachment[];
    acquired: HarnessConnectionAcquisition; journal: ExecutionJournal; request: HarnessExecutionRequest; signal: AbortSignal;
}
type Mutation = (options: HarnessMutationOptions) => Promise<unknown>;
export function nativeOptions(run: NativeExecution, requestId?: string): HarnessMutationOptions {
    return { signal: run.signal, epoch: run.journal.data.epoch, ...(requestId ? { requestId } : {}) };
}
export async function nativeMutation(run: NativeExecution, step: string, call: Mutation): Promise<unknown> {
    run.signal.throwIfAborted();
    const saved = run.journal.data.operations[step];
    if (saved) return settledOperation(run, step, saved);
    const operation: NativeOperation = { requestId: nativeOperationId(run.journal.context, step), outcome: 'pending' };
    await run.journal.operation(step, operation);
    run.signal.throwIfAborted();
    let result: unknown;
    try { result = await call(nativeOptions(run, operation.requestId)); }
    catch (error) {
        if ((error as { outcome?: string })?.outcome === 'not-committed') {
            const code = rejectionCode((error as { code?: unknown }).code);
            await run.journal.operation(step, { ...operation, outcome: 'not-committed', code });
            throw executionError(code);
        }
        throw executionError('NATIVE_OUTCOME_UNKNOWN');
    }
    await run.journal.operation(step, { ...operation, outcome: 'committed', result: jsonValue(result ?? null) });
    return result;
}
export async function settledOperation(run: NativeExecution, step: string, saved: NativeOperation): Promise<unknown> {
    if (saved.outcome === 'committed') return saved.result;
    if (saved.outcome === 'not-committed') throw executionError(saved.code ?? 'NATIVE_REJECTED');
    const receipt = await run.acquired.client.operation(run.acquired.profile.id, saved.requestId, nativeOptions(run));
    if (receipt.requestId !== saved.requestId || receipt.outcome === 'unknown') throw executionError('NATIVE_OUTCOME_UNKNOWN');
    const operation: NativeOperation = { ...saved, outcome: receipt.outcome,
        ...(receipt.result !== undefined ? { result: jsonValue(receipt.result) } : {}), ...(receipt.code ? { code: rejectionCode(receipt.code) } : {}) };
    await run.journal.operation(step, operation);
    if (receipt.outcome !== 'committed') throw executionError(rejectionCode(receipt.code));
    return receipt.result;
}
function rejectionCode(value: unknown): string {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'NATIVE_REJECTED';
}
export async function prepareNativeTurn(run: NativeExecution): Promise<void> {
    assertPreparedAttachments(run);
    const { client, profile, workspaceId } = run.acquired;
    if (!run.journal.data.sessionId) {
        const result = await nativeMutation(run, 'create', options => client.create(profile.id, workspaceId, options));
        const id = (result as { session?: { id?: unknown } })?.session?.id;
        if (typeof id !== 'string' || !id) throw executionError('NATIVE_SESSION_INVALID');
        await run.journal.save({ sessionId: id });
    }
    if (!run.journal.data.turnId) {
        const result = await nativeMutation(run, 'turn', options => client.turn(profile.id, run.journal.data.sessionId!,
            run.request.prompt, { ...options, selection: run.request.connection.selection,
                ...(run.attachments?.length ? {attachments: run.attachments} : {}) }));
        const id = (result as { turnId?: unknown })?.turnId;
        if (typeof id !== 'string' || !id) throw executionError('NATIVE_TURN_INVALID');
        await run.journal.save({ turnId: id });
    }
}

function assertPreparedAttachments(run: NativeExecution): void {
    if (!run.request.attachments?.length || run.journal.data.turnId || run.journal.data.operations.turn) return;
    if (!run.attachments?.length) throw executionError('HARNESS_ATTACHMENTS_NOT_PREPARED');
}
