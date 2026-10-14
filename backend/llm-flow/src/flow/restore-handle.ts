import { readFlowRunMembers } from './run-members';
import type { FlowRunGoal } from '../contracts';
import type { SessionHandle, JsonValue } from '@itookit/durable-kernel';
import type { FlowExecutionHandle } from './executor';

/** Reattach persisted task records; this does not restart the Flow scheduler. */
export async function restoreFlowHandle(session: Pick<SessionHandle, 'id' | 'attachTask' | 'getShared'> & Partial<Pick<SessionHandle, 'listTasks'>>, taskId: string): Promise<FlowExecutionHandle> {
    const root = await session.attachTask<JsonValue>(taskId);
    const task = (await root.status()).task;
    const input = task.input as {
        runTasks?: Array<{ taskId: string; nodeId: string; iteration: number; detached: boolean }>;
        run?: { version: number; goal: FlowRunGoal | null; usage: FlowExecutionHandle['usage'] };
    } | undefined;
    if (task.program.kind !== 'flow.aggregate' || task.labels?.kind !== 'flow-root'
        || input?.run?.version !== 1 || !Array.isArray(input.runTasks)) throw new Error(`Run record unavailable: ${taskId}`);
    const nodes = new Map<string, Awaited<ReturnType<SessionHandle['attachTask']>>>();
    const iterations = new Map<string, number>(), detachedNodes = new Set<string>(), taskIds = new Set([taskId]);
    for (const entry of await readFlowRunMembers(session, task)) {
        if (!entry.taskId || !entry.nodeId || !Number.isSafeInteger(entry.iteration) || entry.iteration < 1) throw new Error('Invalid Run task record');
        const handle = await session.attachTask(entry.taskId);
        taskIds.add(entry.taskId);
        if (entry.detached) detachedNodes.add(entry.nodeId);
        if (entry.iteration <= (iterations.get(entry.nodeId) ?? 0)) continue;
        iterations.set(entry.nodeId, entry.iteration);
        nodes.set(entry.nodeId, handle);
    }
    const saved = await session.getShared(`flow.run.${taskId}.metadata`);
    const metadata = saved ? saved.value as unknown as NonNullable<typeof input.run> : input.run;
    if (metadata?.version !== 1 || !metadata.usage) throw new Error(`Invalid Run metadata: ${taskId}`);
    const goal = await session.getShared(`flow.run.${taskId}.goal`);
    return { sessionId: session.id, root, nodes, iterations, detachedNodes, taskIds,
        goal: goal?.value as unknown as FlowRunGoal ?? metadata.goal ?? undefined,
        usage: metadata.usage, attachedFromStorage: true };
}
