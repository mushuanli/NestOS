import { createModuleLogger, randomUUID } from '@itookit/common';
import { FSError } from '@itookit/vfs-core';

const logger = createModuleLogger('harness-connections');
/** Configuration and acquisition logs contain identities and classifications, never target parameters or credentials. */
export async function traceHarnessConnection<T>(operation: string, connectionId: string | undefined, run: () => Promise<T>): Promise<T> {
    const started = Date.now(), operationId = randomUUID();
    connectionId = typeof connectionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ? connectionId : undefined;
    try {
        const result = await run();
        logger.info('Harness connection operation completed', { operation, operationId, connectionId, stage: 'complete',
            outcome: 'success', durationMs: Date.now() - started });
        return result;
    } catch (error) {
        logger.error('Harness connection operation failed', { operation, operationId, connectionId, stage: 'execute',
            outcome: 'failure', code: error instanceof FSError ? error.code : 'UNEXPECTED', durationMs: Date.now() - started });
        throw error;
    }
}
