import {KernelError, KernelErrorCode, type Kernel} from '@itookit/durable-kernel';
import {sessionDirectoryStorage} from '@itookit/llm-session';
import {createModuleLogger, randomUUID} from '@itookit/common';

const log = createModuleLogger('session-execution');

/** Session metadata and execution storage share one durable identity. */
export function createSessionExecutionPreparer(kernel: Pick<Kernel, 'openSession' | 'createSession'>,
    acquireWrite?: (sessionId: string) => Promise<boolean>) {
    const pending = new Map<string, Promise<void>>();
    return (id: string): Promise<void> => {
        const existing = pending.get(id);
        if (existing) return existing;
        const work = prepareOwned(kernel, id, acquireWrite).finally(() => pending.delete(id));
        pending.set(id, work);
        return work;
    };
}

async function prepareOwned(kernel: Pick<Kernel, 'openSession' | 'createSession'>, id: string,
    acquireWrite?: (sessionId: string) => Promise<boolean>): Promise<void> {
    const metadata = {operation: 'session.execution.prepare', operationId: randomUUID(), sessionId: id}, started = Date.now();
    let stage = 'ownership';
    try {
        if (acquireWrite && !await acquireWrite(id))
            throw Object.assign(new Error('Session execution preparation is read-only'), {code: 'SESSION_EXECUTION_READ_ONLY'});
        stage = 'storage'; await prepare(kernel, id);
        log.info('session.execution.prepare', {...metadata, stage, result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        log.warn('session.execution.prepare', {...metadata, stage, result: 'failure',
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SESSION_EXECUTION_PREPARE_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}

async function prepare(kernel: Pick<Kernel, 'openSession' | 'createSession'>, id: string): Promise<void> {
    const storage = sessionDirectoryStorage(id);
    try {await kernel.openSession(id, storage);}
    catch (error) {
        if (!(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
        await kernel.createSession({id, storage});
    }
}
