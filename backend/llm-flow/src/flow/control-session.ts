import type { Kernel, SessionHandle, SharedLeaseCondition } from '@itookit/durable-kernel';
import { acquireSchedulerLease, isSchedulerOwnershipLost, type SchedulerLease } from './scheduler-lease';
import { fenceSchedulerSession } from './fenced-session';

interface LocalOwner {lease: SchedulerLease; retiring: boolean; holds: Set<Promise<void>>}
const owners = new WeakMap<Kernel, Map<string, LocalOwner>>();

/** The Kernel instance is the local execution host; never borrow another host's lease. */
export function rememberSchedulerLease(kernel: Kernel, rootId: string, lease: SchedulerLease): SchedulerLease {
    let runs = owners.get(kernel);
    if (!runs) { runs = new Map(); owners.set(kernel, runs); }
    const release = lease.release.bind(lease);
    const owner: LocalOwner = {lease, retiring: false, holds: new Set()};
    let releasing: Promise<void> | undefined;
    lease.release = () => {
        owner.retiring = true;
        return releasing ??= Promise.all([...owner.holds]).then(() => release()).finally(() => {
            if (runs!.get(rootId) === owner) runs!.delete(rootId);
        });
    };
    runs.set(rootId, owner);
    return lease;
}

async function performControl<T>(kernel: Kernel, sessionId: string, rootId: string,
    canWrite: ((sessionId: string) => Promise<boolean>) | undefined,
    operation: (session: SessionHandle, lease: SharedLeaseCondition) => Promise<T>): Promise<T> {
    if (canWrite && !await canWrite(sessionId)) throw new Error('Session is read-only on this host');
    const session = await kernel.openSession(sessionId);
    const borrowed = await borrowSchedulerLease(kernel, rootId);
    const lease = borrowed?.lease ?? await acquireSchedulerLease(session, rootId);
    try {
        await lease.assertOwned();
        if (canWrite && !await canWrite(sessionId)) throw new Error('Session is read-only on this host');
        return await operation(fenceSchedulerSession(session, lease.condition), Object.freeze({...lease.condition}));
    } finally {if (borrowed) borrowed.release(); else await lease.release();}
}

/** Keep the local scheduler's heartbeat alive until its in-flight controller returns. */
async function borrowSchedulerLease(kernel: Kernel, rootId: string) {
    const owner = owners.get(kernel)?.get(rootId);
    if (!owner) return;
    if (owner.retiring) {await owner.lease.release(); return;}
    let resolve!: () => void;
    const hold = new Promise<void>(done => {resolve = done;}); owner.holds.add(hold);
    const release = () => {owner.holds.delete(hold); resolve();};
    try {await owner.lease.assertOwned(); return {lease: owner.lease, release};}
    catch (error) {
        release();
        if (!isSchedulerOwnershipLost(error)) throw error;
        await owner.lease.release();
    }
}

const controls = new WeakMap<Kernel, Map<string, Promise<unknown>>>();

/** Serialize local control requests so duplicate retries can share durable receipts. */
export function withFlowControl<T>(kernel: Kernel, sessionId: string, rootId: string,
    canWrite: ((sessionId: string) => Promise<boolean>) | undefined,
    operation: (session: SessionHandle, lease: SharedLeaseCondition) => Promise<T>): Promise<T> {
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
    const owner = owners.get(kernel)?.get(rootId);
    if (!owner || owner.retiring) return false;
    try { await owner.lease.assertOwned(); return true; }
    catch (error) { if (isSchedulerOwnershipLost(error)) return false; throw error; }
}
