export interface FlowRetryControlDiagnostic {
    operation: 'flow.task.retry'; stage: 'control'; outcome: 'accepted' | 'error'; mode: 'task' | 'graph';
    operationId?: string; sessionId?: string; rootTaskId?: string; targetTaskId?: string;
    durationMs: number; code?: string;
}
export interface FlowRunControlDiagnostic {
    operation: 'flow.run.pause' | 'flow.run.resume' | 'flow.run.withdraw' | 'flow.run.cancel'; stage: 'control' | 'legacy-recovery';
    outcome: 'accepted' | 'error'; mode: 'pause' | 'resume' | 'withdraw' | 'cancel';
    operationId?: string; sessionId?: string; rootTaskId?: string;
    durationMs: number; code?: string; retainedCount?: number;
}
export interface FlowSchedulerAdmissionDiagnostic {
    operation: 'flow.scheduler.admit'; stage: 'lease' | 'root-admission'; mode: 'acquire'; outcome: 'error';
    operationId?: string; sessionId?: string; rootTaskId?: string;
    durationMs: number; code: string;
}
export type FlowControlDiagnostic = FlowRetryControlDiagnostic | FlowRunControlDiagnostic | FlowSchedulerAdmissionDiagnostic;

export function reportSchedulerAdmission(input: {sessionId: string; rootTaskId?: string; operationId?: string; durationMs: number; stage?: 'lease' | 'root-admission'},
    error: unknown, report?: (event: FlowControlDiagnostic) => void): void {
    diagnostic(report, {operation: 'flow.scheduler.admit', stage: input.stage ?? 'lease', mode: 'acquire', outcome: 'error',
        sessionId: safeId(input.sessionId), rootTaskId: safeId(input.rootTaskId), operationId: safeId(input.operationId),
        durationMs: input.durationMs, code: schedulerAdmissionCode(error)});
}

function schedulerAdmissionCode(error: unknown): string {
    const value = (error as {code?: unknown} | undefined)?.code;
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'FLOW_SCHEDULER_ADMISSION_FAILED';
}

export async function traceFlowRetry<T>(input: {requestId: string; sessionId: string; taskId: string; targetTaskId: string; downstream?: boolean},
    report: ((event: FlowControlDiagnostic) => void) | undefined, operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const metadata = {operation: 'flow.task.retry' as const, stage: 'control' as const, mode: input.downstream ? 'graph' as const : 'task' as const,
        operationId: safeId(input.requestId), sessionId: safeId(input.sessionId), rootTaskId: safeId(input.taskId), targetTaskId: safeId(input.targetTaskId)};
    try {
        const result = await operation();
        diagnostic(report, {...metadata, outcome: 'accepted', durationMs: Date.now() - started}); return result;
    } catch (error) {
        diagnostic(report, {...metadata, outcome: 'error', code: errorCode(error), durationMs: Date.now() - started}); throw error;
    }
}

export async function traceFlowRunControl<T>(input: {requestId: string; sessionId: string; rootTaskId: string; mode: 'pause' | 'resume' | 'withdraw' | 'cancel'},
    report: ((event: FlowControlDiagnostic) => void) | undefined, operation: () => Promise<T>): Promise<T> {
    const started = Date.now(), metadata = {operation: `flow.run.${input.mode}` as FlowRunControlDiagnostic['operation'], stage: 'control' as const,
        mode: input.mode, operationId: safeId(input.requestId), sessionId: safeId(input.sessionId), rootTaskId: safeId(input.rootTaskId)};
    try {
        const result = await operation(), recovery = result as {limitedRecovery?: boolean; retainedTaskIds?: string[]};
        diagnostic(report, {...metadata, outcome: 'accepted', durationMs: Date.now() - started,
            ...(recovery?.limitedRecovery ? {stage: 'legacy-recovery' as const, code: 'FLOW_LEGACY_CONTROL_RECOVERY',
                retainedCount: recovery.retainedTaskIds?.length ?? 0} : {})});
        return result;
    } catch (error) {
        diagnostic(report, {...metadata, outcome: 'error', code: errorCode(error, 'FLOW_CONTROL_FAILED'), durationMs: Date.now() - started});
        throw error;
    }
}

function diagnostic(report: ((event: FlowControlDiagnostic) => void) | undefined, event: FlowControlDiagnostic): void {
    try {
        if (report) report(event);
        else if (event.outcome === 'error') console.warn(event.operation, event);
        else console.debug(event.operation, event);
    } catch { /* Diagnostics must not change durable control results. */ }
}
function safeId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;}
function errorCode(error: unknown, fallback = 'FLOW_RETRY_FAILED'): string {
    const value = (error as {code?: unknown} | undefined)?.code;
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)) return value;
    const message = error instanceof Error ? error.message : '';
    if (/outside this run/.test(message)) return 'FLOW_RETRY_SOURCE_OUTSIDE_RUN';
    if (/read-only/.test(message)) return 'FLOW_RETRY_READ_ONLY';
    if (/requestId/.test(message)) return 'FLOW_RETRY_REQUEST_INVALID';
    return fallback;
}
