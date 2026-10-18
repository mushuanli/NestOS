import {KernelError, KernelErrorCode, type Kernel} from '@itookit/durable-kernel';
import {sessionDirectoryStorage} from '@itookit/llm-session';

/** Session metadata and execution storage share one durable identity. */
export function createSessionExecutionPreparer(kernel: Pick<Kernel, 'openSession' | 'createSession'>) {
    const pending = new Map<string, Promise<void>>();
    return (id: string): Promise<void> => {
        const existing = pending.get(id);
        if (existing) return existing;
        const work = prepare(kernel, id).finally(() => pending.delete(id));
        pending.set(id, work);
        return work;
    };
}

async function prepare(kernel: Pick<Kernel, 'openSession' | 'createSession'>, id: string): Promise<void> {
    const storage = sessionDirectoryStorage(id);
    try {await kernel.openSession(id, storage);}
    catch (error) {
        if (!(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
        await kernel.createSession({id, storage});
    }
}
