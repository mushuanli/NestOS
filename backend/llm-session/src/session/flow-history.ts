import { createSessionHost, type SessionHost } from '../utils/host-ports';
import { flowLogicInteraction } from './flow-logic-history';
import { flowActor, flowToolInteraction, flowToolId, flowRequestId } from './flow-identity';
import { formatFlowOutput } from '@itookit/llm-flow/contracts';
import { type AgentEvent } from '@itookit/llm-tasks/contracts';
import { type FlowInteraction } from '../contracts';
import type { EventEnvelope, TaskHandle, TaskRecord } from '@itookit/durable-kernel';
import type { ConversationExecution } from './conversation-run-coordinator';
import type { SessionEventBus } from './session-event-bus';
import { flowInteractionNode } from '../persistence/projection';

/** History presentation is independent of the model's history inclusion policy. */
export class FlowHistory {
    readonly interactions: FlowInteraction[] = [];
    private attempts = new Map<string, { content: string; thinking: string }>();
    constructor(private execution: ConversationExecution, private bus: SessionEventBus, private host: SessionHost = createSessionHost()) {}

    async consume(handle: TaskHandle): Promise<void> {
        const task = (await handle.status()).task;
        const visible = !['flow.dispatch', 'flow.aggregate', 'flow.value'].includes(task.program.kind);
        const input = ['flow.input', 'flow.human'].includes(task.program.kind);
        const entry = visible && !input ? this.append(task) : undefined;
        for await (const envelope of handle.events()) {
            if (entry) this.event(entry, envelope);
            const logic = flowLogicInteraction(task, envelope, this.host.translate);
            if (logic && !this.interactions.some(item => item.id === logic.id)) this.append(task, logic);
            if (envelope.type === 'agent.event' && String((envelope.payload as AgentEvent).type).startsWith('tool:')) {
                this.tool((await handle.status()).task, envelope.payload as AgentEvent);
            }
            if (envelope.type === 'task.interaction.requested') this.request((await handle.status()).task, envelope);
            if (envelope.type === 'task.interaction.resolved') await this.response(handle, envelope);
        }
        const final = (await handle.status()).task;
        if (entry) this.finish(entry, final);
        if (input && final.output !== undefined && !this.interactions.some(item => item.taskId === task.id && item.role === 'user')) {
            this.finish(this.append(task), final);
        }
        for (const pending of this.interactions.filter(item => item.taskId === task.id && (item.status === 'waiting_input' || (item.actor?.kind === 'tool' && item.status === 'running')))) {
            pending.status = final.status === 'cancelled' ? 'aborted' : final.status === 'succeeded' ? 'success' : 'failed';
            this.status(pending);
        }
    }

    private append(task: TaskRecord, overrides: Partial<FlowInteraction> = {}): FlowInteraction {
        const entry: FlowInteraction = { id: `flow-${task.id}`, taskId: task.id,
            name: task.labels?.flowNodeName ?? task.labels?.dispatchKey ?? task.labels?.flowNodeId ?? task.program.kind,
            actor: flowActor(task), parallelGroup: task.labels?.flowHistoryGroup,
            role: ['flow.input', 'flow.human'].includes(task.program.kind) ? 'user' : 'assistant',
            status: 'running', content: '', createdAt: task.createdAt, ...overrides };
        this.interactions.push(entry);
        const node = flowInteractionNode(entry, this.execution.rootNodeId);
        this.execution.state.appendChildNode(this.execution.rootNodeId, node);
        this.bus.emitSession(this.execution.task.sessionId, { type: 'node:appended', payload: { parentId: this.execution.rootNodeId, node } });
        return entry;
    }

    private event(entry: FlowInteraction, envelope: EventEnvelope): void {
        if (envelope.type === 'effect.retry.scheduled') {
            const retry = envelope.payload as { effectId: string };
            if (!retry.effectId.startsWith('llm-')) return;
            const baseline = this.attempts.get(`${entry.id}:${retry.effectId}`) ?? { content: '', thinking: '' };
            entry.content = baseline.content; entry.thinking = baseline.thinking;
            this.execution.state.updateNodeOutput(entry.id, entry.content);
            this.execution.state.updateNodeThought(entry.id, entry.thinking);
            for (const field of ['output', 'thought'] as const) this.bus.emitSession(this.execution.task.sessionId,
                { type: 'message:updated', payload: { messageId: entry.id, field, content: field === 'output' ? entry.content : entry.thinking } });
            return;
        }
        if (envelope.type !== 'agent.event') return;
        const event = envelope.payload as AgentEvent;
        if (event.type === 'llm:request') { this.requestSnapshot(entry, event); return; }
        if (event.type !== 'stream:content' && event.type !== 'stream:thinking') return;
        const field = event.type === 'stream:thinking' ? 'thought' : 'output';
        if (field === 'thought') {
            entry.thinking = (entry.thinking ?? '') + event.delta;
            this.execution.state.appendToNode(entry.id, event.delta, 'thought');
        } else {
            entry.content += event.delta;
            this.execution.state.updateNodeOutput(entry.id, entry.content);
        }
        this.bus.emitSession(this.execution.task.sessionId, { type: 'message:updated',
            payload: { messageId: entry.id, delta: event.delta, field } });
    }

    private requestSnapshot(entry: FlowInteraction, event: Extract<AgentEvent, { type: 'llm:request' }>): void {
        const key = `${entry.id}:${event.effectId}`;
        if (!this.attempts.has(key)) this.attempts.set(key, { content: entry.content, thinking: entry.thinking ?? '' });
        const { type: _type, ...request } = event;
        const requests = entry.requests ??= [];
        const index = requests.findIndex(item => item.effectId === request.effectId);
        if (index < 0) requests.push(request); else requests[index] = request;
        const metaInfo = { requests: [...requests] };
        this.execution.state.updateNodeMeta(entry.id, metaInfo);
        this.bus.emitSession(this.execution.task.sessionId, { type: 'message:updated', payload: { messageId: entry.id, metaInfo } });
    }

    private tool(task: TaskRecord, event: AgentEvent): void {
        if (event.type !== 'tool:queued' && event.type !== 'tool:running' && event.type !== 'tool:success' && event.type !== 'tool:error') return;
        const id = flowToolId(task.id, event.call.toolId);
        const entry = this.interactions.find(item => item.id === id)
            ?? this.append(task, { ...flowToolInteraction(task, event.call.name, event.call.toolId), input: event.call.input });
        if (event.type === 'tool:success') { entry.status = 'success'; this.replace(entry, event.call.result); }
        else if (event.type === 'tool:error') { entry.status = 'failed'; entry.error = event.call.error; this.replace(entry, event.call.error); }
        else entry.status = 'running';
        this.status(entry);
    }

    private request(task: TaskRecord, envelope: EventEnvelope): void {
        const request = envelope.payload as { id: string; prompt?: string; kind?: string };
        this.append(task, { id: flowRequestId(task.id, request.id), role: 'assistant',
            actor: { ...flowActor(task), kind: request.kind === 'approval' ? 'approval' : 'input' },
            status: 'waiting_input', content: request.prompt ?? '', name: request.kind === 'approval' ? 'Approval' : 'Input' });
        const entry = this.interactions.find(item => item.id === `flow-${task.id}`);
        if (entry) { entry.status = 'waiting_input'; this.status(entry); }
        if (task.interactions?.[request.id]?.status === 'pending') {
            this.bus.emitGlobal({ type: 'execution_task_projected', payload: {
                sessionId: this.execution.task.sessionId, taskId: task.id, roundId: this.execution.roundId,
            } });
        }
    }

    private async response(handle: TaskHandle, envelope: EventEnvelope): Promise<void> {
        const task = (await handle.status()).task;
        const { interactionId } = envelope.payload as { interactionId: string };
        const request = this.interactions.find(item => item.id === flowRequestId(task.id, interactionId));
        if (request) { request.status = 'success'; this.status(request); }
        const response = task.interactions[interactionId]?.response;
        if (response !== undefined) this.append(task, { id: `${flowRequestId(task.id, interactionId)}-response`,
            role: 'user', name: 'Input', actor: { ...flowActor(task), kind: task.interactions[interactionId]?.kind ?? 'input' }, status: 'success', content: typeof response === 'string' ? response : JSON.stringify(response, null, 2) });
        const entry = this.interactions.find(item => item.id === `flow-${task.id}`);
        if (entry) { entry.status = 'running'; this.status(entry); }
    }

    private finish(entry: FlowInteraction, task: TaskRecord): void {
        entry.status = task.status === 'succeeded' ? 'success' : task.status === 'cancelled' ? 'aborted' : 'failed';
        entry.error = task.exit?.error?.message ?? task.lastError?.message;
        if (task.output !== undefined) this.replace(entry, formatFlowOutput(task.output));
        else if (entry.error) this.replace(entry, entry.content ? `${entry.content}\n\n${entry.error}` : entry.error);
        this.status(entry);
    }

    private replace(entry: FlowInteraction, content: string): void {
        entry.content = content;
        this.execution.state.updateNodeOutput(entry.id, content);
        this.bus.emitSession(this.execution.task.sessionId, { type: 'message:updated',
            payload: { messageId: entry.id, field: 'output', content } });
    }

    private status(entry: FlowInteraction): void {
        this.execution.state.updateNodeStatus(entry.id, entry.status);
        this.bus.emitSession(this.execution.task.sessionId, { type: 'message:status', payload: { messageId: entry.id, status: entry.status } });
    }
}
