import type { SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import { bindFlowTaskCapabilities } from '../task-capabilities';
import type { DispatchInput } from './types';

/** Reconcile only children of known dispatch owners; Kernel owns their spawn identity. */
export async function reconcileDispatchChildren(session: SessionHandle, owners: TaskHandle[], visit: (task: TaskHandle) => void, maxConcurrency: number): Promise<number | undefined> {
    if (!owners.length) return;
    const all = await session.listTasks();
    const ownerIds = new Set(owners.map(owner => owner.id));
    if (!all.some(task => ownerIds.has(task.id) && task.program.kind === 'flow.dispatch')) return;
    let active = all.filter(task => task.program.kind !== 'flow.dispatch'
        && (ownerIds.has(task.id) || (task.parentTaskId && ownerIds.has(task.parentTaskId)))
        && !['created', 'succeeded', 'failed', 'cancelled'].includes(task.status)).length;
    for (const owner of owners) {
        const parent = all.find(task => task.id === owner.id);
        if (!parent || parent.program.kind !== 'flow.dispatch') continue;
        const input = parent.input as DispatchInput;
        for (const child of all.filter(task => task.parentTaskId === parent.id)) {
            const handle = await session.attachTask(child.id);
            visit(handle);
            if (parent.status === 'cancelled' || parent.status === 'failed') continue;
            if (child.status !== 'created') continue;
            if (active >= maxConcurrency || (parent.control && parent.control.mode !== 'run')) continue;
            const branch = [...input.branches, ...(input.revision?.invocation ? [input.revision.invocation] : [])]
                .find(branch => branch.key === child.labels?.dispatchKey);
            if (!branch) throw new Error('Dispatch child has no declared branch');
            if (child.program.kind === 'llm.agent' || child.program.kind === 'llm.chat') {
                await bindFlowTaskCapabilities(session, handle, child.program.kind, branch.target.capabilities ?? [], branch.target.budget);
            } else await handle.start();
            active++;
        }
    }
    return active;
}
