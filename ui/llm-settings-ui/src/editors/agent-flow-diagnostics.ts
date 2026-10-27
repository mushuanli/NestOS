/** Log identifiers and fixed classifications only; exception text may contain form data. */
export interface FlowConfigurationScope {
    operationId: string;
    agentId: string;
    flowId: string;
    requestedRevision: number | 'latest' | 'invalid';
    flowCount: number;
}
const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
const safeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(value) ? value : undefined;

export function configurationScope(operationId: string, agentId: string, flowId: string, raw: string, flowCount: number): FlowConfigurationScope {
    return {operationId, agentId: safeId(agentId) ?? '[invalid-id]', flowId: safeId(flowId) ?? (flowId ? '[invalid-id]' : ''),
        requestedRevision: !raw ? 'latest' : /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : 'invalid', flowCount};
}
export function configurationFailure(error: unknown, stage: string, code: string): Error {
    return Object.assign(new Error(error instanceof Error ? error.message : 'Flow configuration unavailable', {cause: error}), {failureStage: stage, code});
}
export function configurationError(error: unknown): Record<string, unknown> {
    const failure = error as {failureStage?: string; code?: string; cause?: unknown};
    let cause = failure?.cause ?? error;
    const details: Record<string, unknown> = {};
    for (let depth = 0; cause && typeof cause === 'object' && depth < 4; depth++) {
        const item = cause as {code?: unknown; remoteCode?: unknown; requestId?: unknown; name?: unknown; cause?: unknown; outcome?: unknown};
        if (safeCode(item.code)) details.causeCode = safeCode(item.code);
        if (safeCode(item.remoteCode)) details.remoteCode = safeCode(item.remoteCode);
        if (safeId(item.requestId)) details.requestId = safeId(item.requestId);
        if (['Error', 'TypeError', 'RangeError', 'AbortError', 'FSError', 'DOMException'].includes(String(item.name))) details.errorName = item.name;
        if (['committed', 'not-committed', 'unknown'].includes(String(item.outcome))) details.outcome = item.outcome;
        cause = item.cause;
    }
    return {...details, stage: failure?.failureStage ?? 'render', code: safeCode(failure?.code) ?? 'FLOW_CONFIGURATION_RENDER_FAILED'};
}
export function reportFlowConfiguration(event: string, scope: FlowConfigurationScope, started: number, details: Record<string, unknown>): void {
    const data = {operation: 'agent.flow.configuration', ...scope, ...details, durationMs: Math.round(performance.now() - started)};
    if (details.result === 'failure') console.error(event, data); else console.info(event, data);
}
