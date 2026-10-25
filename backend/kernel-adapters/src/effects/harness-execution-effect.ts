import { assertEffectGrant, type EffectAdapter, type EffectExecutionContext, type EffectReconcileResult } from '@itookit/durable-kernel';
import type { LLMLogSink } from '@itookit/driver-llm/contracts';
import type { HarnessExecutionProvider, HarnessExecutionRequest, HarnessExecutionResult } from '../llm-management/contracts/harness-execution';
import { InFlightEffects } from './in-flight';
import { silentAdapterLog } from '../ports/diagnostics';
import {assertConnectionCleanupConfirmed} from '../llm-management/contracts/connection-control';
import {reconcileConnectionEffect} from './connection-reconcile';

/** The host owns transport, project authorization and operation reconciliation. */
export class HarnessExecutionEffect implements EffectAdapter<HarnessExecutionRequest, HarnessExecutionResult> {
    readonly kind = 'harness.execute';
    readonly version = '1';
    private readonly inFlight = new InFlightEffects();
    constructor(private readonly provider?: HarnessExecutionProvider, private readonly log: LLMLogSink = silentAdapterLog) {}
    shouldRetry(): boolean { return false; }
    failureOutcome(error: unknown): 'failed' | 'indeterminate' {
        return (error as { effectOutcome?: unknown })?.effectOutcome === 'indeterminate' ? 'indeterminate' : 'failed';
    }
    execute(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<HarnessExecutionResult> {
        return this.inFlight.track(context, this.invoke(request, context, false));
    }
    reconcile(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<EffectReconcileResult<HarnessExecutionResult>> {
        return this.inFlight.track(context, this.invoke(request, context, true));
    }
    async cancel(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<void> {
        const started = Date.now();
        try {
            if (!this.provider) throw new Error('HARNESS_EXECUTION_UNAVAILABLE');
            // Cancellation has no execution grants. The provider verifies its persisted owned invocation.
            assertConnectionCleanupConfirmed(await this.provider.cancel(request, context), context);
            await this.inFlight.confirmStopped(context);
            this.diagnostic(request, context, 'cancel', started, 'confirmed');
        } catch (error) {this.diagnostic(request, context, 'cancel', started, 'unconfirmed', failureCode(error)); throw error;}
    }
    private async invoke<T extends boolean>(request: HarnessExecutionRequest, context: EffectExecutionContext, recovery: T):
        Promise<T extends true ? EffectReconcileResult<HarnessExecutionResult> : HarnessExecutionResult> {
        const started = Date.now(), stage = recovery ? 'reconcile' : 'execute';
        let executing = false;
        try {
            assertEffectGrant(context, request.resourceHandleId, 'harness');
            context.abortSignal.throwIfAborted();
            if (!context.sessionState) throw new Error('HARNESS_PERSISTENT_STATE_REQUIRED');
            if (!this.provider) throw new Error('HARNESS_EXECUTION_UNAVAILABLE');
            executing = true;
            const result = recovery ? reconcileConnectionEffect(await this.provider.reconcile(request, context), context) : await this.provider.execute(request, context);
            const reconciled = recovery ? result as EffectReconcileResult<HarnessExecutionResult> : undefined;
            const status = reconciled?.status ?? 'completed';
            this.diagnostic(request, context, stage, started, status === 'completed' ? 'success' : status,
                reconciled?.status === 'indeterminate' ? failureCode(reconciled.error) : undefined);
            return result as T extends true ? EffectReconcileResult<HarnessExecutionResult> : HarnessExecutionResult;
        } catch (error) {
            const failure = classifyExecutionFailure(error, executing, context.abortSignal.aborted);
            this.diagnostic(request, context, stage, started, this.failureOutcome(failure) === 'indeterminate' ? 'indeterminate' : 'failure',
                context.abortSignal.aborted ? 'cancelled' : failureCode(failure));
            throw failure;
        }
    }
    private diagnostic(request: HarnessExecutionRequest, context: EffectExecutionContext, stage: string, started: number,
        result: string, errorCategory?: string): void {
        try {
            this.log.info('Harness execution', { operation: stage === 'cancel' ? 'harness.cancel' : 'harness.execute', stage, result,
                sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId,
                connectionId: request.connection.id, projectId: request.connection.projectId,
                elapsedMs: Date.now() - started, ...(errorCategory ? { errorCategory } : {}) });
        } catch { /* A diagnostic sink must not rewrite execution or physical cleanup facts. */ }
    }
}

function failureCode(error: unknown): string {
    const value = error as { code?: unknown; message?: unknown } | null;
    if (typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)) return value.code;
    if (typeof value?.message === 'string' && /^HARNESS_[A-Z0-9_]{1,71}$/.test(value.message)) return value.message;
    return 'HARNESS_EXECUTION_ERROR';
}

function executionFailure(error: unknown): unknown {
    const code = failureCode(error);
    if ((error as { executionOutcome?: unknown })?.executionOutcome === 'not-started'
        || code === 'NATIVE_TURN_FAILED' || code === 'NATIVE_TURN_CANCELLED') return error;
    return Object.assign(new Error(`Harness execution: ${code}`), { code, effectOutcome: 'indeterminate' });
}

function classifyExecutionFailure(error: unknown, executing: boolean, aborted: boolean): unknown {
    return executing && !aborted ? executionFailure(error) : error;
}
