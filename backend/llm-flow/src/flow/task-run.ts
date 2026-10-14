import type { JsonValue, SessionHandle, TaskRecord } from '@itookit/durable-kernel';
import type { FlowWorkspacePolicy } from '../contracts';
import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { readFlowRunMembers } from './run-members';

export interface FlowTaskWorkspace {
    rootTaskId: string;
    policy: FlowWorkspacePolicy;
    lease: JsonValue;
}

/** Missing isolated-workspace records are errors, never permission to use the shared directory. */
export async function resolveFlowTaskWorkspace(session: SessionHandle, taskId: string): Promise<FlowTaskWorkspace | undefined> {
    const root = await resolveFlowRunForTask(session, taskId);
    if (!root) return undefined;
    const saved = await session.getShared(`flow.run.${root.id}.scheduler`);
    const checkpoint = saved?.value as unknown as SchedulerCheckpoint | undefined;
    if (!checkpoint?.spec || !Array.isArray(checkpoint.spec.nodes)) throw new Error(`Flow checkpoint is unavailable: ${root.id}`);
    const policy = checkpoint.spec.runPolicy?.workspace;
    if (!policy || policy.mode === 'shared') return undefined;
    if (policy.mode !== 'worktree' && policy.mode !== 'read-only') throw new Error(`Invalid Flow workspace policy: ${root.id}`);
    const lease = await session.getShared(`flow.run.${root.id}.workspace-lease`);
    if (!lease || lease.value === null) throw new Error(`Flow workspace lease is unavailable: ${root.id}`);
    return { rootTaskId: root.id, policy: structuredClone(policy), lease: structuredClone(lease.value) };
}

/** Resolve independent Flow nodes and their descendants using authoritative Run membership. */
export async function resolveFlowRunForTask(session: SessionHandle, taskId: string): Promise<TaskRecord | undefined> {
    const tasks = await session.listTasks();
    const ancestors = taskAncestry(session.id, tasks, taskId);
    let selected: TaskRecord | undefined, nearest = Infinity;
    for (const root of tasks.filter(task => task.program.kind === 'flow.aggregate' && task.labels?.kind === 'flow-root')) {
        const members = await readFlowRunMembers(session, root);
        const distance = Math.min(...[root.id, ...members.map(member => member.taskId)]
            .map(id => ancestors.indexOf(id)).filter(index => index >= 0));
        if (distance === Infinity || distance > nearest) continue;
        if (distance === nearest) throw new Error(`Ambiguous Flow membership for Task: ${taskId}`);
        selected = root;
        nearest = distance;
    }
    if (!selected && tasks.some(task => ancestors.includes(task.id) && task.labels?.flowNodeId)) {
        throw new Error(`Flow membership is missing for Task: ${taskId}`);
    }
    return selected;
}

function taskAncestry(sessionId: string, tasks: TaskRecord[], taskId: string): string[] {
    const records = new Map(tasks.map(task => [task.id, task]));
    const ancestors: string[] = [];
    let current: string | undefined = taskId;
    while (current) {
        if (ancestors.includes(current)) throw new Error(`Task ancestry cycle: ${taskId}`);
        const task = records.get(current);
        if (!task || task.sessionId !== sessionId) throw new Error(`Task ancestry is unavailable: ${current}`);
        ancestors.push(current);
        current = task.parentTaskId;
    }
    return ancestors;
}
