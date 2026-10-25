import {HarnessConnectionCleanup} from './harness-connection-cleanup';
import type { EffectExecutionContext, EffectSessionState } from '@itookit/durable-kernel';
import type { ConnectionCancelResult, ConnectionReconcileResult, HarnessExecutionProvider, HarnessExecutionRequest, HarnessExecutionResult } from '@itookit/kernel-adapters/contracts';
import type {HarnessConnectionService, HarnessConnectionAcquisition} from './harness-connections';
import { ExecutionJournal, executionError, harnessExecutionJournalKey, type ExecutionJournalData } from './harness-execution-journal';
import { prepareNativeTurn, type NativeExecution } from './harness-execution-operations';
import { finishNativeTurn, observeNativeTurn } from './harness-execution-observation';
import { cancelNativeExecution } from './harness-execution-cancel';
import {claimExecutionContext, settleExecutionContext, validateExecutionContext} from './harness-execution-context';
import {prepareExecutionAttachments} from './harness-execution-assets';

export { harnessExecutionJournalKey } from './harness-execution-journal';
export interface HarnessExecutionOptions {
    readTaskAsset?: import('@itookit/tools/contracts').TaskAssetReader;
    stateForCleanup?: (context: EffectExecutionContext) => Promise<EffectSessionState>;
    settleContextForCleanup?: (journal: ExecutionJournal, unstarted: boolean, context: EffectExecutionContext) => Promise<import('@itookit/kernel-adapters/contracts').ContextBindingRef | undefined>;
    pollMs?: number;
    cancelTimeoutMs?: number;
}
type Connections = Pick<HarnessConnectionService, 'acquire' | 'validate'>;
export function createHarnessExecutionProvider(connections: Connections, options: HarnessExecutionOptions = {}): HarnessExecutionProvider {
    return new NativeHarnessExecutionProvider(connections, options);
}
class NativeHarnessExecutionProvider implements HarnessExecutionProvider {
    private readonly connectionCleanup = new HarnessConnectionCleanup();
    private readonly active = new Map<string, Promise<unknown>>();
    constructor(private readonly connections: Connections, private readonly options: HarnessExecutionOptions) {}
    execute(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<HarnessExecutionResult> {
        return this.track(context, this.run(request, context));
    }
    async reconcile(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<ConnectionReconcileResult<HarnessExecutionResult>> {
        const startedAt = Date.now();
        try {
            await this.connectionCleanup.retry(context);
            const journal = this.journal(request, context);
            if (!await journal.load()) return {status: 'not-started', evidence: {kind: 'not-started', ref: harnessExecutionJournalKey(context),
                sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId}};
            if (journal.data.result) return { status: 'completed', result: journal.data.result };
            return { status: 'completed', result: await this.track(context, this.run(request, context)) };
        } catch (error) {
            const code = safeCode(error);
            if ((error as { executionOutcome?: string })?.executionOutcome === 'not-started'
                || code === 'NATIVE_TURN_FAILED' || code === 'NATIVE_TURN_CANCELLED') throw error;
            await diagnose(context, 'reconcile', 'unknown', startedAt, code);
            return {status: 'unknown', code};
        }
    }
    async cancel(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<ConnectionCancelResult> {
        const startedAt = Date.now();
        try {
            if (!this.options.stateForCleanup) throw executionError('CLEANUP_STATE_UNAVAILABLE');
            const kind = await cancelNativeExecution({acquire: () => this.acquire(request, context)}, request, context, this.options,
                this.active.get(harnessExecutionJournalKey(context)));
            await this.connectionCleanup.retry(context);
            await diagnose(context, 'cancel', 'confirmed', startedAt);
            return {status: 'stopped', cleanup: 'confirmed', evidence: {kind, ref: harnessExecutionJournalKey(context),
                sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId}};
        } catch (error) { await diagnose(context, 'cancel', 'pending', startedAt, safeCode(error)); throw error; }
    }
    private async acquire(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<HarnessConnectionAcquisition> {
        return this.connectionCleanup.own(context, await this.connections.acquire(request.connection));
    }
    private async run(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<HarnessExecutionResult> {
        const startedAt = Date.now();
        await this.connectionCleanup.retry(context);
        const journal = this.journal(request, context);
        const exists = await journal.load();
        if (exists && journal.data.result) return journal.data.result;
        if (exists && journal.data.forkRejected) throw Object.assign(executionError(journal.data.forkRejected), {executionOutcome: 'not-started'});
        if (exists && replayableTerminal(journal.data)) return finishNativeTurn({ journal });
        context.abortSignal.throwIfAborted();
        const acquired = await this.acquire(request, context);
        try {
            return await this.dispatch(request, context, journal, acquired, exists, startedAt);
        } catch (error) {return this.failExecution(error, request, context, journal, startedAt);}
        finally { await acquired.release(); }
    }
    private async dispatch(request: HarnessExecutionRequest, context: EffectExecutionContext, journal: ExecutionJournal,
        acquired: HarnessConnectionAcquisition, exists: boolean, startedAt: number): Promise<HarnessExecutionResult> {
        if (!exists) await journal.initialize(acquired.epoch);
        if (journal.data.epoch !== acquired.epoch) throw executionError('NATIVE_EPOCH_CHANGED');
        const attachments = journal.data.turnId || journal.data.operations.turn ? undefined
            : await this.prepareInput(request, context, journal, acquired, startedAt);
        if (request.context?.conversation.mode === 'fork' && (!acquired.profile.capabilities.checkpointFork || !acquired.client.fork))
            throw executionError('CONTEXT_CHECKPOINT_FORK_UNSUPPORTED');
        await claimExecutionContext(journal, request);
        const correlation = executionCorrelation(request, journal);
        if (request.context) await diagnose(context, 'context-binding', 'claimed', startedAt, undefined, correlation);
        const run: NativeExecution = {acquired, journal, request, attachments, signal: context.abortSignal};
        await prepareNativeTurn(run);
        await diagnose(context, 'observe', 'accepted', startedAt, undefined, correlation);
        const result = await observeNativeTurn(run, context, this.options.pollMs ?? 1000);
        await diagnose(context, 'observe', 'completed', startedAt, undefined, correlation);
        return result;
    }
    private async failExecution(error: unknown, request: HarnessExecutionRequest, context: EffectExecutionContext,
        journal: ExecutionJournal, startedAt: number): Promise<never> {
        const failure = classifyExecutionFailure(error, journal), correlation = executionCorrelation(request, journal);
        try {
            if ((failure as {executionOutcome?: string})?.executionOutcome === 'not-started') await settleExecutionContext(journal, true);
        } catch (settlementError) {
            await diagnose(context, 'context-settlement', 'pending', startedAt, safeCode(settlementError), correlation); throw settlementError;
        }
        await diagnose(context, 'execute', 'failure', startedAt, safeCode(failure), correlation); throw failure;
    }
    private async prepareInput(request: HarnessExecutionRequest, context: EffectExecutionContext, journal: ExecutionJournal,
        acquired: HarnessConnectionAcquisition, startedAt: number): Promise<import('@itookit/kernel-adapters/contracts').HarnessInlineAttachment[] | undefined> {
        const correlation = executionCorrelation(request, journal);
        try {
            const attachments = await prepareExecutionAttachments(request, context, acquired.profile, this.options.readTaskAsset);
            if (attachments?.length) await diagnose(context, 'input-preparation', 'prepared', startedAt, undefined,
                {...correlation, attachmentCount: attachments.length, assetCount: request.attachments?.filter(file => file.kind === 'asset').length ?? 0,
                    attachmentBytes: attachments.reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0)});
            return attachments;
        } catch (error) {await diagnose(context, 'input-preparation', 'failure', startedAt, safeCode(error), correlation); throw error;}
    }
    private journal(request: HarnessExecutionRequest, context: EffectExecutionContext): ExecutionJournal {
        if (!context.sessionState) throw executionError('DURABLE_STATE_UNAVAILABLE');
        if (!request.notificationKey || !request.prompt.trim()) throw executionError('REQUEST_INVALID');
        validateExecutionContext(request);
        return new ExecutionJournal(context.sessionState, context, request);
    }
    private track<T>(context: EffectExecutionContext, operation: Promise<T>): Promise<T> {
        const key = harnessExecutionJournalKey(context);
        this.active.set(key, operation);
        void operation.finally(() => { if (this.active.get(key) === operation) this.active.delete(key); }).catch(() => {});
        return operation;
    }
}
function replayableTerminal(data: ExecutionJournalData): boolean {
    return !!data.terminal && (data.terminal !== 'completed' || data.outputChecked === true);
}
function classifyExecutionFailure(error: unknown, journal: ExecutionJournal): unknown {
    const data = journal.data;
    const notStarted = data?.operations.create?.outcome === 'not-committed' || data?.operations.fork?.outcome === 'not-committed'
        || data?.operations.turn?.outcome === 'not-committed' && !data.turnId
        || !!data?.forkRejected || data && !data.operations.create && !data.operations.fork && !data.operations.turn && !data.sessionId;
    return notStarted ? Object.assign(error instanceof Error ? error : executionError(safeCode(error)), { executionOutcome: 'not-started' }) : error;
}
export function safeCode(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'NATIVE_OUTCOME_UNKNOWN';
}
function executionCorrelation(request: HarnessExecutionRequest, journal: ExecutionJournal) {
    return {invocationId: diagnosticId(request.context?.invocationId), bindingId: diagnosticId(journal.data?.bindingId)};
}
function diagnosticId(value?: string): string | undefined {return value && /^[\w.:%-]{1,256}$/.test(value) ? value : undefined;}
async function diagnose(context: EffectExecutionContext, stage: string, outcome: string, startedAt: number, code?: string,
    correlation?: {invocationId?: string; bindingId?: string; attachmentCount?: number; attachmentBytes?: number; assetCount?: number}): Promise<void> {
    const payload = { operation: 'harness.execution', operationId: harnessExecutionJournalKey(context), stage, outcome,
        sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, durationMs: Date.now() - startedAt,
        ...correlation, ...(code ? { code } : {}) };
    try { await context.emit?.({ type: 'harness:execution', payload }); }
    catch { /* Diagnostics cannot change native execution or cleanup evidence. */ }
}
