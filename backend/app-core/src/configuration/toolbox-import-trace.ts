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
    private context: {stage: string; kind?: string; index?: number} = {stage: 'parse'};
    step(stage: string, kind?: string, index?: number): void { this.context = {stage, kind, index}; }
    async run(work: () => Promise<string[]>): Promise<string[]> {
        log.info('toolbox.import.started', {operationId: this.operationId});
        try {
            const paths = await work();
            log.info('toolbox.import.completed', {operationId: this.operationId, count: paths.length, durationMs: this.duration()});
            return paths;
        } catch (error) {
            log.error('toolbox.import.failed', {operationId: this.operationId, ...this.context, code: errorCode(error), durationMs: this.duration()});
            throw error;
        }
    }
    rollbackFailed(error: unknown): void {
        log.error('toolbox.import.rollback.failed', {operationId: this.operationId, code: errorCode(error), durationMs: this.duration()});
    }
    private duration(): number { return Math.round(performance.now() - this.started); }
}
