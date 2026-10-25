import type {TaskRecord, SessionHandle} from '@itookit/durable-kernel';
import {readFlowRunMembers, type FlowRunMember} from './run-members';
import {invocationFromLabels} from './invocation-identity';

/** Current membership decides the selected attempt; cached loop counts never override it. */
export function latestFlowMembers(members: readonly FlowRunMember[]): Map<string, FlowRunMember> {
    const latest = new Map<string, FlowRunMember>();
    for (const member of members) {
        if (member.iteration >= (latest.get(member.nodeId)?.iteration ?? 0)) latest.set(member.nodeId, member);
    }
    return latest;
}

/** Historical attempts are display facts, not additional execution/control membership. */
export function invocationTaskHistory(root: TaskRecord, tasks: readonly TaskRecord[], members: ReadonlySet<string>): TaskRecord[] {
    const included = new Set([...members, root.id]), children = new Map<string, Array<{task: TaskRecord; invocationId: string}>>();
    for (const task of tasks) {
        const identity = invocationFromLabels(task.labels);
        if (!identity?.parentInvocationId || task.sessionId !== root.sessionId) continue;
        const rows = children.get(identity.parentInvocationId) ?? [];
        rows.push({task, invocationId: identity.invocationId}); children.set(identity.parentInvocationId, rows);
    }
    const identity = invocationFromLabels(root.labels), queue = identity ? [identity.invocationId] : [], visited = new Set(queue);
    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]) ?? []) {
        included.add(child.task.id);
        if (!visited.has(child.invocationId)) {visited.add(child.invocationId); queue.push(child.invocationId);}
    }
    appendTaskDescendants(root.sessionId, tasks, included);
    return tasks.filter(task => task.sessionId === root.sessionId && included.has(task.id)).map(task => task.id === root.id ? root : task)
        .sort((a, b) => a.id === b.id ? 0 : a.id === root.id ? -1 : b.id === root.id ? 1
        : a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function appendTaskDescendants(sessionId: string, tasks: readonly TaskRecord[], included: Set<string>): void {
    const children = new Map<string, string[]>(), queue = [...included];
    for (const task of tasks) if (task.sessionId === sessionId && task.parentTaskId) {
        const rows = children.get(task.parentTaskId) ?? [];
        rows.push(task.id); children.set(task.parentTaskId, rows);
    }
    for (let index = 0; index < queue.length; index++) for (const id of children.get(queue[index]) ?? []) {
        if (!included.has(id)) {included.add(id); queue.push(id);}
    }
}

export async function readInvocationFrame(session: Pick<SessionHandle, 'getShared' | 'listTasks'>, root: TaskRecord,
    previous: ReadonlySet<string>) {
    const tasks = await session.listTasks();
    const members = await readFlowRunMembers({getShared: session.getShared.bind(session), listTasks: async () => tasks}, root);
    const history = invocationTaskHistory(root, tasks, new Set([...previous, ...members.map(member => member.taskId)]));
    return {members, latest: latestFlowMembers(members), history};
}
