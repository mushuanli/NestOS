// @file: llm-session/src/persistence/projection.ts
// Shared Round → UI projection helpers for tool invocations. Keeps the
// `assistantBlocks` + `toolResults` persistence shape (RoundResult) and the
// ExecutionNode tree shape (tool children) in one place.

import type { Round, RoundResult } from '../contracts';
import type { ExecutionNode, NodeStatus } from '../core/types';
import type { RoundProjection, ToolCallProjection } from './round-types';

/**
 * Map a persisted Round status onto the assistant node status.
 *
 * Only terminal failures differ from the historical default (`success`): a
 * failed Round must surface as `failed`, an aborted one as `aborted`, so the
 * transcript never looks like a successful empty answer.
 */
export function roundStatusToNodeStatus(status: Round['status']): NodeStatus {
    if (status === 'running' || status === 'pending') return 'running';
    if (status === 'waiting') return 'waiting_input';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'aborted';
    return 'success';
}

/** True for terminal statuses that need a placeholder assistant bubble. */
export function isFailedRoundStatus(status: Round['status']): boolean {
    return status === 'failed' || status === 'cancelled';
}

/** Rebuild the flat tool-call list from a persisted RoundResult. */
export function toolCallsFromResult(result: RoundResult | undefined): ToolCallProjection[] {
    if (!result) return [];
    const toolResults = result.toolResults ?? [];
    return (result.assistantBlocks ?? [])
        .filter(block => block.type === 'tool_use')
        .map(block => {
            const id = String(block.toolUseId ?? block.id ?? '');
            const match = toolResults.find(item => item.toolUseId === id);
            return {
                toolId: id,
                name: String(block.name ?? ''),
                input: isRecord(block.input) ? block.input : undefined,
                result: match?.content,
                isError: match?.isError,
            };
        });
}

/** Build tool ExecutionNode children for an assistant message projection. */
export function buildToolChildren(projection: RoundProjection): ExecutionNode[] {
    const assistant = projection.assistantMessage;
    if (!assistant?.toolCalls?.length) return [];
    return assistant.toolCalls.map((call, index) => ({
        id: call.toolId || `tool-${projection.roundId}-${index}`,
        parentId: assistant.persistedNodeId,
        executorId: call.name,
        executorType: 'tool',
        name: call.name,
        status: call.isError ? 'failed' : 'success',
        startTime: projection.createdAt,
        data: {
            input: call.input,
            output: call.result ?? '',
            toolCall: { name: call.name, args: call.input, result: call.result },
        },
        children: [],
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Rebuild display-only workflow interactions without adding model history messages. */
export function flowInteractionNode(entry: import('../contracts').FlowInteraction, parentId: string): ExecutionNode {
    return { id: entry.id, parentId, messageRole: entry.role, executorId: entry.taskId, executorType: 'composite',
        name: entry.name, status: entry.status, startTime: entry.createdAt,
        data: { input: entry.input, output: entry.content, thought: entry.thinking, error: entry.error, metaInfo: { flowInteraction: true, actor: entry.actor, parallelGroup: entry.parallelGroup, requests: entry.requests } }, children: [] };
}

export function buildFlowChildren(projection: RoundProjection): ExecutionNode[] {
    return (projection.assistantMessage?.flowInteractions ?? []).map(entry =>
        flowInteractionNode(entry, projection.assistantMessage!.persistedNodeId));
}
