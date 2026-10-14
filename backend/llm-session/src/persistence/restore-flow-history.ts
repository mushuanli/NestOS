import { createSessionHost, type SessionHost } from '../utils/host-ports';
import type { EventEnvelope, Kernel } from '@itookit/durable-kernel';
import { readFlowRunMembers } from '@itookit/llm-flow';
import type { PersistedRound } from './round-types';
import { projectTaskInteractions, runTasks } from './flow-run-projection';

/** Rebuild a display snapshot without modifying the Round or resuming its tasks. */
export async function restoreFlowHistory(kernel: Kernel, round: PersistedRound, host: SessionHost = createSessionHost()): Promise<PersistedRound> {
    if (!round.flow || round._deleted || (['completed', 'failed', 'cancelled'].includes(round.status) && round.result?.flowInteractions?.length)) return round;
    const rootId = round.executions.find(execution => execution.role === 'primary')?.taskId;
    if (!rootId) return round;
    const tasks = await kernel.listSessionTasks(round.sessionId);
    const root = tasks.find(task => task.id === rootId);
    if (!root || root.program.kind !== 'flow.aggregate' || root.labels?.kind !== 'flow-root') return round;
    const session = await kernel.openSession(round.sessionId);
    const members = await readFlowRunMembers(session, root);
    const interactions = [];
    for (const task of runTasks(root, tasks, members.map(member => member.taskId))) {
        if (task.id === root.id) continue;
        const events = await taskEvents(kernel, round.sessionId, task.id);
        interactions.push(...projectTaskInteractions(task, events, host.translate));
    }
    if (!interactions.length) return round;
    return { ...round, result: { assistantBlocks: [], toolResults: [], ...round.result, flowInteractions: interactions.sort((a, b) => a.createdAt - b.createdAt) } };
}

async function taskEvents(kernel: Kernel, sessionId: string, taskId: string): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    let afterIndex = 0;
    do {
        const page = await kernel.taskEventPage(sessionId, taskId, { afterIndex, limit: 100 });
        events.push(...page.items.filter(event => ['agent.event', 'flow.logic.completed', 'effect.retry.scheduled'].includes(event.type)));
        if (page.nextAfterIndex === undefined) return events;
        afterIndex = page.nextAfterIndex;
    } while (true);
}
