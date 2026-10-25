import type {EffectExecutionContext, EffectReconcileResult} from '@itookit/durable-kernel';
import {assertConnectionNotStarted, type ConnectionReconcileResult} from '../llm-management/contracts/connection-control';

/** Running and uncertain native operations must never become new executions. */
export function reconcileConnectionEffect<T>(result: ConnectionReconcileResult<T>, context: EffectExecutionContext): EffectReconcileResult<T> {
    if (result?.status === 'completed') return {status: 'completed', result: result.result};
    if (result?.status === 'not-started') {
        assertConnectionNotStarted(result.evidence, context);
        return {status: 'retry'};
    }
    const code = unresolvedCode(result);
    return {status: 'indeterminate', error: {code, message: `Connection reconciliation: ${code}`}};
}

function unresolvedCode(result: ConnectionReconcileResult<unknown>): string {
    if (result?.status === 'running') return validHandleRef(result.handleRef) ? 'CONNECTION_STILL_RUNNING' : 'CONNECTION_RECONCILE_RESULT_INVALID';
    if (result?.status === 'unknown') return nativeCode(result.code);
    return 'CONNECTION_RECONCILE_RESULT_INVALID';
}
function validHandleRef(value: unknown): boolean {return typeof value === 'string' && value.length > 0 && value.length <= 4096;}
function nativeCode(value: unknown): string {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'CONNECTION_STATE_UNKNOWN';
}
