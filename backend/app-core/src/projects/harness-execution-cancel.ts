import type { EffectExecutionContext } from '@itookit/durable-kernel';
import type { HarnessExecutionRequest } from '@itookit/kernel-adapters/contracts';
import type { HarnessConnectionService } from './harness-connections';
import type { HarnessExecutionOptions } from './harness-execution';
import { ExecutionJournal, executionError } from './harness-execution-journal';
import { nativeMutation, settledOperation, type NativeExecution } from './harness-execution-operations';
import { observeNativePage, waitForNativeChange } from './harness-execution-observation';

export async function cancelNativeExecution(connections: Pick<HarnessConnectionService, 'acquire'>,
    request: HarnessExecutionRequest, context: EffectExecutionContext, options: HarnessExecutionOptions, active?: Promise<unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.cancelTimeoutMs ?? 10_000);
    try {
        await settleObserver(active, controller.signal);
        const state = await options.stateForCleanup!(context);
        const journal = new ExecutionJournal(state, context, request);
        if (!await journal.load() || journal.data.terminal) return;
        const acquired = await connections.acquire(request.connection);
        try {
            if (acquired.epoch !== journal.data.epoch) throw executionError('NATIVE_EPOCH_CHANGED');
            const run: NativeExecution = { acquired, journal, request, signal: controller.signal };
            if (!await recoverReferences(run)) return;
            await stopNativeTurn(run, options.pollMs ?? 1000);
        } finally { await acquired.release(); }
    } finally { clearTimeout(timeout); }
}
async function recoverReferences(run: NativeExecution): Promise<boolean> {
    for (const step of ['create', 'turn'] as const) {
        if (!await recoverReference(run, step)) return false;
    }
    return true;
}
async function recoverReference(run: NativeExecution, step: 'create' | 'turn'): Promise<boolean> {
    const operation = run.journal.data.operations[step];
    if (!operation || operation.outcome === 'not-committed') return false;
    let value: { session?: { id?: unknown }; turnId?: unknown };
    try { value = await settledOperation(run, step, operation) as typeof value; }
    catch (error) { if (run.journal.data.operations[step]?.outcome === 'not-committed') return false; throw error; }
    const id = step === 'create' ? value?.session?.id : value?.turnId;
    if (typeof id !== 'string' || !id) throw executionError('NATIVE_REFERENCE_INVALID');
    const key = step === 'create' ? 'sessionId' : 'turnId';
    if (run.journal.data[key] !== id) await run.journal.save({ [key]: id });
    return true;
}
async function stopNativeTurn(run: NativeExecution, pollMs: number): Promise<void> {
    await observeNativePage(run);
    if (run.journal.data.terminal) return;
    try {
        await nativeMutation(run, 'interrupt', options => run.acquired.client.interrupt(run.acquired.profile.id,
            run.journal.data.sessionId!, run.journal.data.turnId!, options));
    } catch (error) {
        await observeNativePage(run);
        if (!run.journal.data.terminal) throw error;
    }
    while (!run.journal.data.terminal) {
        await observeNativePage(run);
        if (!run.journal.data.terminal) await waitForNativeChange(run, pollMs);
    }
}
function settleObserver(active: Promise<unknown> | undefined, signal: AbortSignal): Promise<void> {
    if (!active) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const abort = () => reject(executionError('CLEANUP_OBSERVER_PENDING'));
        signal.addEventListener('abort', abort, { once: true });
        void active.catch(() => {}).then(() => { signal.removeEventListener('abort', abort); resolve(); });
        if (signal.aborted) abort();
    });
}
