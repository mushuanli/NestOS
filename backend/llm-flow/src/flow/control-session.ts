import type { Kernel, SessionHandle } from '@itookit/durable-kernel';
import { acquireSchedulerLease, isSchedulerOwnershipLost, type SchedulerLease } from './scheduler-lease';
import { fenceSchedulerSession } from './fenced-session';

const owners = new WeakMap<Kernel, Map<string, SchedulerLease>>();

/** The Kernel instance is the local execution host; never borrow another host's lease. */
export function rememberSchedulerLease(kernel: Kernel, rootId: string, lease: SchedulerLease): SchedulerLease {
    let runs = owners.get(kernel);
    if (!runs) { runs = new Map(); owners.set(kernel, runs); }
    const release = lease.release.bind(lease);
    let releasing: Promise<void> | undefined;
    lease.release = () => releasing ??= release().finally(() => {
        if (runs!.get(rootId) === lease) runs!.delete(rootId);
    });
    runs.set(rootId, lease);
    return lease;
}

async function performControl<T>(kernel: Kernel, sessionId: string, rootId: string,
    canWrite: ((sessionId: string) => Promise<boolean>) | undefined,
    operation: (session: SessionHandle) => Promise<T>): Promise<T> {
    if (canWrite && !await canWrite(sessionId)) throw new Error('Session is read-only on this host');
    const session = await kernel.openSession(sessionId);
    let borrowed = owners.get(kernel)?.get(rootId);
    if (borrowed) {
        try { await borrowed.assertOwned(); }
        catch (error) {
            if (!isSchedulerOwnershipLost(error)) throw error;
            await borrowed.release(); borrowed = undefined;
        }
    }
    const lease = borrowed ?? await acquireSchedulerLease(session, rootId);
    try {
        await lease.assertOwned();
        if (canWrite && !await canWrite(sessionId)) throw new Error('Session is read-only on this host');
        return await operation(fenceSchedulerSession(session, lease.condition));
    } finally { if (!borrowed) await lease.release(); }
}

const controls = new WeakMap<Kernel, Map<string, Promise<unknown>>>();

/** Serialize local control requests so duplicate retries can share durable receipts. */
export function withFlowControl<T>(kernel: Kernel, sessionId: string, rootId: string,
    canWrite: ((sessionId: string) => Promise<boolean>) | undefined,
    operation: (session: SessionHandle) => Promise<T>): Promise<T> {
    let pending = controls.get(kernel);
    if (!pending) { pending = new Map(); controls.set(kernel, pending); }
    const work = (pending.get(rootId) ?? Promise.resolve()).catch(() => undefined)
        .then(() => performControl(kernel, sessionId, rootId, canWrite, operation));
    pending.set(rootId, work);
    const clear = () => { if (pending!.get(rootId) === work) pending!.delete(rootId); };
    void work.then(clear, clear);
    return work;
}

export async function hasLocalScheduler(kernel: Kernel, rootId: string): Promise<boolean> {
    const lease = owners.get(kernel)?.get(rootId);
    if (!lease) return false;
    try { await lease.assertOwned(); return true; }
    catch (error) { if (isSchedulerOwnershipLost(error)) return false; throw error; }
}
