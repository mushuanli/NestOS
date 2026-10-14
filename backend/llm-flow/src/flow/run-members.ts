import { taskStat } from '@itookit/durable-kernel';
import type { SessionHandle, TaskRecord, TaskHandle } from '@itookit/durable-kernel';

export interface FlowRunMember {
    taskId: string;
    nodeId: string;
    iteration: number;
    detached: boolean;
    budget?: Record<string, number>;
    retryOfTaskId?: string;
}

export async function readFlowRunMembers(session: Pick<SessionHandle, 'getShared'> & Partial<Pick<SessionHandle, 'listTasks'>>, root: TaskRecord): Promise<FlowRunMember[]> {
    if (root.program.kind !== 'flow.aggregate' || root.labels?.kind !== 'flow-root') throw new Error(`Not a Flow run: ${root.id}`);
    const scheduled = await session.getShared(`flow.run.${root.id}.members`);
    const base = members(scheduled?.value ?? (root.input as { runTasks?: unknown } | undefined)?.runTasks);
    const saved = await session.getShared(`flow.run.${root.id}.retries`);
    const result = [...base, ...members(saved?.value ?? [])];
    if (session.listTasks) appendDescendants(result, await session.listTasks());
    return result;
}

function appendDescendants(result: FlowRunMember[], tasks: TaskRecord[]): void {
    const known = new Map(result.map(member => [member.taskId, member]));
    const owners = new Set(tasks.filter(task => task.program?.kind === 'flow.dispatch').map(task => task.id));
    let added = true;
    while (added) {
        added = false;
        for (const task of tasks) {
            const parent = task.parentTaskId ? known.get(task.parentTaskId) : undefined;
            if (!parent || !owners.has(task.parentTaskId!) || known.has(task.id)) continue;
            const member = { taskId: task.id, nodeId: `${parent.nodeId}/${task.labels?.dispatchKey ?? task.id}`,
                iteration: Number(task.labels?.dispatchRound) || 1, detached: parent.detached };
            result.push(member); known.set(task.id, member); owners.add(task.id); added = true;
        }
    }
}

/** Detached members may outlive the aggregate root. Drain them before closing workspace handles. */
export async function waitForFlowRunTasks(session: SessionHandle, rootId: string): Promise<void> {
    const root = (await (await session.attachTask(rootId)).status()).task;
    const ids = new Set([rootId, ...(await readFlowRunMembers(session, root)).map(member => member.taskId)]);
    while (true) {
        for (const member of await readFlowRunMembers(session, root)) ids.add(member.taskId);
        const tasks = await session.listTasks();
        let grew = true;
        while (grew) {
            grew = false;
            for (const task of tasks) if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
                ids.add(task.id); grew = true;
            }
        }
        const pending = tasks.filter(task => task.id !== rootId && ids.has(task.id) && !['succeeded', 'failed', 'cancelled'].includes(task.status));
        if ([...ids].some(id => !tasks.some(task => task.id === id))) throw new Error('Flow workspace member is unavailable');
        const active = tasks.some(task => ids.has(task.id) && taskStat(task).activeOperations > 0);
        if (!pending.length && !active) return;
        if (pending.length) await Promise.all(pending.map(async task => (await session.attachTask(task.id)).wait()));
        else await new Promise(resolve => setTimeout(resolve, 25));
    }
}

/** Prepare a deferred retry and publish membership before any authorization or execution. */
export async function prepareFlowTaskRetry(session: SessionHandle, rootId: string, sourceId: string, requestId: string): Promise<TaskHandle> {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Flow retry requires requestId');
    const root = (await (await session.attachTask(rootId)).status()).task;
    const entries = await readFlowRunMembers(session, root);
    const source = entries.find(entry => entry.taskId === sourceId);
    if (!source) throw new Error(`Task is outside this run: ${sourceId}`);
    const retry = await (await session.attachTask(sourceId)).retry({ requestId: `${rootId}:${requestId}` });
    const key = `flow.run.${rootId}.retries`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await session.getShared(key), current = members(saved?.value ?? []);
        if (current.some(entry => entry.taskId === retry.id)) return retry;
        const iteration = Math.max(...entries.concat(current).filter(entry => entry.nodeId === source.nodeId).map(entry => entry.iteration)) + 1;
        if (!Number.isSafeInteger(iteration)) throw new Error('Flow iteration overflow');
        const entry = { ...source, taskId: retry.id, iteration, retryOfTaskId: sourceId };
        try {
            await session.setShared(key, JSON.parse(JSON.stringify([...current, entry])), { expectedVersion: saved?.version ?? null });
            return retry;
        } catch (error) { if (attempt === 2) throw error; }
    }
    throw new Error('Flow retry membership unavailable');
}

function members(value: unknown): FlowRunMember[] {
    if (!Array.isArray(value) || value.some(entry => !entry || typeof entry.taskId !== 'string' || !entry.taskId
        || typeof entry.nodeId !== 'string' || !entry.nodeId || !Number.isSafeInteger(entry.iteration) || entry.iteration < 1)) {
        throw new Error('Invalid Flow membership record');
    }
    return value;
}
