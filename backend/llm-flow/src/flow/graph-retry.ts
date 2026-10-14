import { isIdentity, isRecord, strings } from './graph-decoder';
// @file: llm-flow/src/flow/graph-retry.ts
// 图级 retry：重试某节点的 Task 后，让它在下游按新结果重算。
//
// 控制面只写“意图”，不直接改内存调度状态：意图持久化在 Session shared
// `flow.run.<rootTaskId>.graph-retry`，由下一次调度回合（resume/新宿主）消费。
// 这样控制服务与调度进程可以分离，且崩溃不会丢掉已受理的重算请求。

import type { DagEdgeDefinition, DagNodeDefinition } from '../contracts';
import type { JsonValue, SessionHandle } from '@itookit/durable-kernel';
import { readFlowRunMembers } from './run-members';
import { retryFlowTask } from './retry-task';

export interface FlowGraphRetryIntent {
    version: 1;
    requestId: string;
    sourceTaskId: string;
    retryTaskId: string;
    sourceNodeId: string;
    /** 需要丢弃已提交实例并按新上游结果重算的节点（不含源节点本身）。 */
    downstream: string[];
    /** 调度器消费后置位；未消费的意图会在下一次调度回合重放。 */
    applied?: boolean;
}

export interface FlowGraphRetryRequest {
    retryTaskId: string;
    sourceNodeId: string;
    downstream: string[];
}

/** Session shared key holding pending graph-retry intents of a Run. */
export const graphRetryKey = (rootTaskId: string): string => `flow.run.${rootTaskId}.graph-retry`;

/**
 * Retry a Run member and schedule its downstream nodes for recomputation.
 *
 * The Run must be resumable (non-terminal with a scheduler checkpoint): a finished
 * Run's root is immutable, so a graph retry would have nowhere to commit.
 */
export async function requestFlowGraphRetry(
    session: SessionHandle,
    rootId: string,
    sourceTaskId: string,
    requestId: string,
): Promise<FlowGraphRetryRequest> {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Flow graph retry requires requestId');
    const checkpoint = (await session.getShared(`flow.run.${rootId}.scheduler`))?.value as
        SchedulerGraph | undefined;
    if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.nodes) || !Array.isArray(checkpoint.edges)) {
        throw new Error('Flow scheduler checkpoint is missing; graph retry needs a resumable Run');
    }
    const root = (await (await session.attachTask(rootId)).status()).task;
    if (root.status === 'succeeded' || root.status === 'failed' || root.status === 'cancelled') {
        throw new Error(`Run is terminal: ${root.status}`);
    }
    const source = (await readFlowRunMembers(session, root)).find(entry => entry.taskId === sourceTaskId);
    if (!source) throw new Error(`Task is outside this run: ${sourceTaskId}`);
    const sourceTask = (await (await session.attachTask(sourceTaskId)).status()).task;
    if (sourceTask.labels?.dispatchKey) throw new Error('Retry the structured route scope instead of a dispatched child');
    // Delegated children are materialized per parent instance: recomputing a parent drops
    // its group, so synthetic children are not retried directly, only through their parent.
    if (source.nodeId.includes(':delegate:')) {
        throw new Error(`Graph retry is not supported for delegated node: ${source.nodeId}`);
    }
    const downstream = downstreamNodes(source.nodeId, checkpoint.nodes, checkpoint.edges)
        .filter(nodeId => !nodeId.includes(':delegate:'));
    const retry = await retryFlowTask(session, rootId, sourceTaskId, requestId);
    const intent: FlowGraphRetryIntent = {
        version: 1, requestId, sourceTaskId, retryTaskId: retry.id, sourceNodeId: source.nodeId, downstream,
    };
    await appendIntent(session, rootId, intent);
    return { retryTaskId: retry.id, sourceNodeId: source.nodeId, downstream };
}

/** Nodes reachable from `sourceNodeId` following edges, excluding the source itself. */
export function downstreamNodes(
    sourceNodeId: string,
    nodes: DagNodeDefinition[],
    edges: DagEdgeDefinition[],
): string[] {
    if (!nodes.some(node => String(node.id) === sourceNodeId)) throw new Error(`Unknown node: ${sourceNodeId}`);
    const known = new Set(nodes.map(node => String(node.id)));
    const seen = new Set<string>([sourceNodeId]);
    const queue = [sourceNodeId];
    while (queue.length) {
        const current = queue.shift()!;
        for (const edge of edges) {
            if (edge.from !== current) continue;
            const target = String(edge.to);
            if (!known.has(target) || seen.has(target)) continue;
            seen.add(target);
            queue.push(target);
        }
    }
    seen.delete(sourceNodeId);
    return [...seen].sort();
}

async function appendIntent(session: SessionHandle, rootId: string, intent: FlowGraphRetryIntent): Promise<void> {
    const key = graphRetryKey(rootId);
    for (let attempt = 0; attempt < 5; attempt++) {
        const saved = await session.getShared(key);
        const current = decodeGraphRetryIntents(saved?.value);
        if (current.some(entry => entry.requestId === intent.requestId)) return;
        try {
            await session.setShared(key, [...current, intent] as unknown as JsonValue,
                { expectedVersion: saved?.version ?? null });
            return;
        } catch (error) { if (attempt === 4) throw error; }
    }
}

interface SchedulerGraph {
    version?: number;
    nodes?: DagNodeDefinition[];
    edges?: DagEdgeDefinition[];
}

/** CAS retries may re-read the queue, but must not repeat live graph mutations. */
export async function consumeGraphRetryIntents(
    session: Pick<SessionHandle, 'getShared' | 'setShared'>,
    rootId: string,
    apply: (intent: FlowGraphRetryIntent) => Promise<void>,
    persist?: () => Promise<void>,
): Promise<number> {
    const key = graphRetryKey(rootId);
    const reconciled = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt++) {
        const saved = await session.getShared(key);
        const intents = decodeGraphRetryIntents(saved?.value);
        const pending = intents.filter(intent => !intent.applied);
        if (!pending.length) return reconciled.size;
        for (const intent of pending) {
            if (reconciled.has(intent.requestId)) continue;
            await apply(intent);
            reconciled.add(intent.requestId);
        }
        // Commit reconciled graph state and receipts before acknowledging the queue.
        await persist?.();
        try {
            await session.setShared(key, intents.map(intent => intent.applied ? intent : { ...intent, applied: true }) as unknown as JsonValue,
                { expectedVersion: saved?.version ?? null });
            return reconciled.size;
        } catch (error) { if (attempt === 4) throw error; }
    }
    return reconciled.size;
}

/** Refuse corrupt queues before applying or acknowledging any intent. */
export function decodeGraphRetryIntents(value: unknown): FlowGraphRetryIntent[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isRetryIntent)) throw new TypeError('Invalid Flow graph retry queue');
    return value;
}
function isRetryIntent(value: unknown): value is FlowGraphRetryIntent {
    return isRecord(value) && value.version === 1
        && ['requestId', 'sourceTaskId', 'retryTaskId', 'sourceNodeId'].every(key => isIdentity(value[key]))
        && strings(value.downstream) && (value.applied === undefined || typeof value.applied === 'boolean');
}
