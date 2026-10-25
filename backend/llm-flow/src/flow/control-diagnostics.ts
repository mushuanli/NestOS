export interface FlowSchedulerAdmissionDiagnostic {
    operation: 'flow.scheduler.admit'; stage: 'lease' | 'root-admission'; mode: 'acquire'; outcome: 'error';
    operationId?: string; sessionId?: string; rootTaskId?: string;
    durationMs: number; code: string;
}
export type FlowControlDiagnostic = FlowSchedulerAdmissionDiagnostic;

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

function diagnostic(report: ((event: FlowControlDiagnostic) => void) | undefined, event: FlowControlDiagnostic): void {
    try {
        if (report) report(event);
        else if (event.outcome === 'error') console.warn(event.operation, event);
        else console.debug(event.operation, event);
    } catch { /* Diagnostics must not change durable control results. */ }
}
function safeId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;}
