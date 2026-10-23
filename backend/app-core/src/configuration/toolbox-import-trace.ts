import { createModuleLogger, randomUUID } from '@itookit/common';

const log = createModuleLogger('toolbox-import');
const errorCode = (error: unknown): string => {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : error instanceof SyntaxError ? 'INVALID_JSON' : 'TOOLBOX_IMPORT_FAILED';
};

/** Log import boundaries without resource names, definitions, credentials or raw exceptions. */
export class ToolboxImportTrace {
    private readonly operationId = randomUUID();
    private readonly started = performance.now();
    private readiness = 'ready';
    private context: {stage: string; kind?: string; index?: number} = {stage: 'parse'};
    step(stage: string, kind?: string, index?: number): void { this.context = {stage, kind, index}; }
    async run(work: () => Promise<string[]>): Promise<string[]> {
        log.info('toolbox.import.started', {operationId: this.operationId});
        try {
            const paths = await work();
            log.info('toolbox.import.completed', {operationId: this.operationId, count: paths.length, outcome: this.readiness, durationMs: this.duration()});
            return paths;
        } catch (error) {
            log.error('toolbox.import.failed', {operationId: this.operationId, ...this.context, code: errorCode(error), durationMs: this.duration()});
            throw error;
        }
    }
    dependencies(reports: ReadonlyArray<{status: string}>): void {
        this.readiness = ['failed', 'missingTools', 'needsConfiguration'].find(status => reports.some(report => report.status === status)) ?? 'ready';
        const counts = Object.fromEntries(['ready', 'missingTools', 'needsConfiguration', 'failed'].map(status => [status, reports.filter(report => report.status === status).length]));
        log.info('toolbox.import.dependencies', {operationId: this.operationId, stage: 'dependencies', outcome: this.readiness, counts, durationMs: this.duration()});
    }
    rollbackFailed(error: unknown): void {
        log.error('toolbox.import.rollback.failed', {operationId: this.operationId, code: errorCode(error), durationMs: this.duration()});
    }
    private duration(): number { return Math.round(performance.now() - this.started); }
}
