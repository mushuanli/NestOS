import type { FlowActor, FlowInteraction } from '../contracts';
import type { TaskRecord } from '@itookit/durable-kernel';

export function record(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function flowActor(task: TaskRecord, toolName?: string, toolCallId?: string): FlowActor {
    const input = record(task.input), state = record(task.state);
    const skills = Array.isArray(state.skillContexts) ? state.skillContexts : input.skillContexts ?? [];
    const skillIds = skills.filter((skill: any) => !toolName || skill.tools?.some((tool: any) =>
        tool.toolId === toolName || (tool.definition?.function?.name ?? tool.definition?.name) === toolName))
        .map((skill: any) => skill.skillId).filter((id: unknown): id is string => typeof id === 'string');
    return { kind: toolName ? 'tool' : 'node', nodeId: task.labels?.flowNodeId ?? task.labels?.dispatchKey,
        nodeName: task.labels?.flowNodeName ?? task.labels?.dispatchKey ?? task.labels?.flowNodeId,
        agentId: task.labels?.agentId, skillIds: [...new Set<string>(skillIds)],
        ...(toolName ? { toolName, toolCallId } : {}),
        ...(task.labels?.dispatchRound ? { round: Number(task.labels.dispatchRound) } : {}) };
}

export function flowTaskStatus(task: TaskRecord): FlowInteraction['status'] {
    if (task.status === 'succeeded') return 'success';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'cancelled') return 'aborted';
    return Object.values(task.interactions ?? {}).some(request => request.status === 'pending') ? 'waiting_input' : 'running';
}

export function flowToolId(taskId: string, callId: string): string {
    return `flow-${taskId}-tool-${Array.from(callId).map(char => char.codePointAt(0)!.toString(16)).join('-')}`;
}

export function flowToolInteraction(task: TaskRecord, name: string, callId: string): FlowInteraction {
    return { id: flowToolId(task.id, callId), taskId: task.id, name, role: 'assistant',
        actor: flowActor(task, name, callId), status: 'running', content: '', createdAt: task.createdAt };
}

export function flowRequestId(taskId: string, requestId: string): string {
    return flowToolId(taskId, requestId).replace('-tool-', '-request-');
}
