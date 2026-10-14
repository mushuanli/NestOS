import type { DagNodeDefinition } from '../../contracts';
import type { SessionHandle, TaskHandle, TaskRecord } from '@itookit/durable-kernel';
import { bindFlowTaskCapabilities } from '../task-capabilities';
import { object } from '../structured/value';

interface Scheduling {
    session: SessionHandle;
    instances: Map<string, TaskHandle[]>;
    tasks: Map<string, TaskRecord>;
    running: TaskRecord[];
    active: number;
    maxConcurrency: number;
    started: Map<string, number>;
}

export function memberGroup(nodes: DagNodeDefinition[], id: string): DagNodeDefinition | undefined {
    return nodes.find(node => node.plugin === 'builtin.taskGroup' && (object(node.config).members as string[] | undefined)?.includes(id));
}

/** Reserved workers have durable identities before a join starts observing them. */
export async function startReservedWorkers(session: SessionHandle, nodes: DagNodeDefinition[], instances: Map<string, TaskHandle[]>, maxConcurrency: number, detached = new Set<string>()): Promise<number | undefined> {
    if (!nodes.some(node => node.plugin === 'builtin.taskGroup')) return;
    const ids = new Set([...instances].filter(([id]) => !detached.has(id)).flatMap(([, handles]) => handles.map(handle => handle.id)));
    const tasks = (await session.listTasks()).filter(task => ids.has(task.id) || task.parentTaskId && ids.has(task.parentTaskId));
    const running = tasks.filter(task => !['created', 'succeeded', 'failed', 'cancelled'].includes(task.status)
        && !['flow.join', 'flow.dispatch'].includes(task.program.kind));
    const state: Scheduling = { session, instances, tasks: new Map(tasks.map(task => [task.id, task])), running,
        active: running.length, maxConcurrency, started: new Map() };
    for (const node of nodes) {
        const group = memberGroup(nodes, node.id);
        if (group) await startMember(state, node, group);
    }
    return state.active;
}

async function startMember(state: Scheduling, node: DagNodeDefinition, group: DagNodeDefinition): Promise<void> {
    const pending = (state.instances.get(node.id) ?? []).filter(handle => state.tasks.get(handle.id)?.status === 'created');
    if (!pending.length) return;
    const groupTask = state.tasks.get(state.instances.get(group.id)?.at(-1)?.id ?? '');
    const limit = Number(object(object(groupTask?.input).config).maxConcurrency ?? object(group.config).maxConcurrency);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid task group concurrency: ${group.id}`);
    const members = object(group.config).members as string[];
    let groupActive = state.running.filter(task => members.some(id => state.instances.get(id)?.some(handle => handle.id === task.id))).length
        + (state.started.get(group.id) ?? 0);
    for (const handle of pending) {
        if (state.active >= state.maxConcurrency || groupActive >= limit) break;
        const task = state.tasks.get(handle.id)!;
        if (task.control && task.control.mode !== 'run') continue;
        if (task.program.kind === 'llm.agent' || task.program.kind === 'llm.chat') await bindFlowTaskCapabilities(state.session, handle, task.program.kind, node.capabilities ?? [], node.budget);
        else await handle.start();
        state.active++; groupActive++;
        state.started.set(group.id, (state.started.get(group.id) ?? 0) + 1);
    }
}
