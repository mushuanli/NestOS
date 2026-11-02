import {createModuleLogger} from '@itookit/common';
const log = createModuleLogger('KanbanDevelopment');
export async function developmentStage<T>(operationId: string, stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
        const value = await work();
        log.info('Development stage', {operation: 'kanban.development', operationId, stage, result: 'success', durationMs: Date.now() - started});
        return value;
    } catch (error) {
        const raw = (error as {code?: unknown})?.code;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'DEVELOPMENT_STAGE_FAILED';
        log.warn('Development stage', {operation: 'kanban.development', operationId, stage, result: 'failure', code, gitStage: /^[a-z-]{1,40}$/.test(String((error as {stage?: unknown})?.stage)) ? (error as {stage: string}).stage : undefined,
            exitCode: Number.isInteger((error as {exitCode?: number})?.exitCode) ? (error as {exitCode: number}).exitCode : undefined, durationMs: Date.now() - started});
        throw error;
    }
}

export function developmentObservation(operationId: string, stage: string, outcome: string, code: string | undefined, durationMs: number): void {
    const event = {operation: 'kanban.development', operationId, stage, outcome, code, durationMs};
    if (['unknown', 'failed', 'cancelled'].includes(outcome)) log.warn('Development lifecycle', event);
    else log.info('Development lifecycle', event);
}
