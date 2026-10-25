import type { HarnessMutationOptions } from '@itookit/mindos-node-driver';
import type { HarnessExecutionRequest, HarnessInlineAttachment } from '@itookit/kernel-adapters/contracts';
import type { HarnessConnectionAcquisition } from './harness-connections';
import { ExecutionJournal, executionError, jsonValue, nativeOperationId, type NativeOperation } from './harness-execution-journal';
import {attachExecutionContext} from './harness-execution-context';

export interface NativeExecution {
    acquired: HarnessConnectionAcquisition; journal: ExecutionJournal; request: HarnessExecutionRequest; signal: AbortSignal;
    attachments?: HarnessInlineAttachment[];
}
type Mutation = (options: HarnessMutationOptions) => Promise<unknown>;
export const NATIVE_MUTATION_HELD = Symbol('native-mutation-held');
export function nativeOptions(run: NativeExecution, requestId?: string): HarnessMutationOptions {
    return { signal: run.signal, epoch: run.journal.data.epoch, ...(requestId ? { requestId } : {}) };
}
export async function nativeMutation(run: NativeExecution, step: string, call: Mutation, requireRunning = false): Promise<unknown> {
    run.signal.throwIfAborted();
    const saved = run.journal.data.operations[step];
    if (saved) return settledOperation(run, step, saved);
    const operation: NativeOperation = { requestId: nativeOperationId(run.journal.context, step), outcome: 'pending' };
    if (requireRunning) {
        if (!await run.journal.operationIfRunning(step, operation)) return NATIVE_MUTATION_HELD;
    } else await run.journal.operation(step, operation);
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
    if (run.request.context?.conversation.mode === 'fork') await prepareForkSession(run);
    else if (!run.journal.data.sessionId) {
        const result = await nativeMutation(run, 'create', options => client.create(profile.id, workspaceId, options));
        const id = (result as { session?: { id?: unknown } })?.session?.id;
        if (typeof id !== 'string' || !id) throw executionError('NATIVE_SESSION_INVALID');
        await run.journal.save({ sessionId: id });
    }
    await attachExecutionContext(run);
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

async function prepareForkSession(run: NativeExecution): Promise<void> {
    const source = run.journal.data.forkSource;
    if (!source || !run.acquired.client.fork) throw executionError('CONTEXT_CHECKPOINT_FORK_UNSUPPORTED');
    if (source.nativeRef.epoch !== run.acquired.epoch || source.nativeRef.profileId !== run.acquired.profile.id)
        throw executionError('CONTEXT_NATIVE_EPOCH_CHANGED');
    if (run.journal.data.sessionId && run.journal.data.operations.fork?.outcome !== 'committed') throw executionError('JOURNAL_CONFLICT');
    const result = await nativeMutation(run, 'fork', options => run.acquired.client.fork!(run.acquired.profile.id,
        source.nativeRef.sessionId, undefined, {...options, lastTurnId: source.checkpointRef}));
    await recordForkReference(run, result);
    if (run.journal.data.forkRejected) throw executionError(run.journal.data.forkRejected);
}

/** Recovery records created identity even when checkpoint verification failed; it never retries the fork. */
export async function recordForkReference(run: NativeExecution, result: unknown): Promise<void> {
    const source = run.journal.data.forkSource, value = result as import('@itookit/mindos-node-driver/harness').HarnessForkResult;
    const id = value?.session?.id;
    if (!source || typeof id !== 'string' || !id) throw executionError('NATIVE_REFERENCE_INVALID');
    if (run.journal.data.sessionId !== id) await run.journal.save({sessionId: id});
    const reason = forkRejection(value, source);
    if (reason) {
        if (run.journal.data.turnId) throw executionError('JOURNAL_CONFLICT');
        await run.journal.save({forkRejected: reason});
    }
    await attachExecutionContext(run);
}
function forkRejection(value: import('@itookit/mindos-node-driver/harness').HarnessForkResult,
    source: NonNullable<ExecutionJournal['data']['forkSource']>): string | undefined {
    const proof = value.checkpoint;
    if (value.session.id !== source.nativeRef.sessionId && proof?.verified === true && proof.sourceSessionId === source.nativeRef.sessionId
        && proof.turnId === source.checkpointRef) return;
    return typeof proof?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(proof.code) ? proof.code : 'CONTEXT_CHECKPOINT_UNCONFIRMED';
}
