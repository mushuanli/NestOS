import { t, type SessionTextKey } from '../utils/host-ports';
import { flowLogicInteraction } from '../session/flow-logic-history';
import { readFlowRunMembers } from '@itookit/llm-flow';
import { formatFlowOutput, outputText } from '@itookit/llm-flow/contracts';
import { type AgentEvent } from '@itookit/llm-tasks/contracts';
import { type FlowInteraction, type Round } from '../contracts';
import type { EventEnvelope, Kernel, TaskRecord } from '@itookit/durable-kernel';
import type { ISessionRepository } from './types';
import { RoundLog } from './round-log';
import { flowActor, flowTaskStatus, flowToolInteraction, flowRequestId, record } from '../session/flow-identity';

export interface FlowRunProjectionOptions {
    sessionId: string;
    rootTaskId: string;
    input: string;
    flow?: Round['flow'];
    selectResult?(output: unknown): unknown;
}

/** Idempotent host projection. Durable Task records remain the execution authority. */
export class FlowRunProjection {
    private signature = '';
    private sessionId = '';
    private cursor = 0;
    private events = new Map<string, EventEnvelope[]>();
    constructor(private repository: ISessionRepository, private kernel: Kernel) {}

    async sync(options: FlowRunProjectionOptions, tasks?: TaskRecord[]): Promise<void> {
        if (this.sessionId !== options.sessionId) {
            this.sessionId = options.sessionId; this.cursor = 0; this.signature = ''; this.events.clear();
        }
        const all = tasks ?? await this.kernel.listSessionTasks(options.sessionId);
        const root = all.find(task => task.id === options.rootTaskId);
        if (!root) return;
        await this.readEvents(options.sessionId);
        const session = await this.kernel.openSession(options.sessionId);
        const identities = await readFlowRunMembers(session, root);
        const members = runTasks(root, all, identities.map(item => item.taskId));
        const signature = JSON.stringify([this.cursor, members.map(task => [task.id, task.version])]);
        if (signature === this.signature) return;
        const log = new RoundLog(this.repository, options.sessionId), roundId = `flow-${root.id}`;
        let round = await log.readRound(roundId);
        if (round?._deleted) return;
        if (!round) {
            const manifest = await log.loadManifest();
            round = { id: roundId, sessionId: options.sessionId, historyParentIds: manifest.currentHead ? [manifest.currentHead] : [],
                input: [{ role: 'user', content: options.input }], output: [], executions: [{ taskId: root.id, role: 'primary' }],
                status: 'running', createdAt: root.createdAt, origin: 'user', ...(options.flow ? { flow: options.flow } : {}) };
            await log.appendExpected(manifest.currentBranch, round, manifest.currentHead);
        }
        await this.update(log, round, root, members, options);
        this.signature = signature;
    }

    private async readEvents(sessionId: string): Promise<void> {
        const events = await this.kernel.eventList(sessionId, this.cursor);
        for (const event of events) {
            this.cursor = event.sequence;
            if (!event.taskId || !['agent.event', 'flow.logic.completed', 'effect.retry.scheduled'].includes(event.type)) continue;
            const type = (event.payload as AgentEvent).type;
            if (event.type === 'agent.event' && type !== 'stream:content' && type !== 'stream:thinking' && type !== 'llm:request' && !type.startsWith('tool:')) continue;
            const entries = this.events.get(event.taskId) ?? [];
            entries.push(event); this.events.set(event.taskId, entries);
        }
    }

    private async update(log: RoundLog, round: Round, root: TaskRecord, tasks: TaskRecord[], options: FlowRunProjectionOptions): Promise<void> {
        // A completed conversation is immutable, even when an old CLI Run is inspected again.
        if (['completed', 'failed', 'cancelled'].includes(round.status)) return;
        const interactions = tasks.filter(task => task.id !== root.id).flatMap(task => projectTaskInteractions(task, this.events.get(task.id))).sort((a, b) => a.createdAt - b.createdAt);
        const result = { assistantBlocks: [], toolResults: [], flowInteractions: interactions };
        if (root.status === 'succeeded') {
            const output = options.selectResult ? options.selectResult(root.output) : root.output;
            await log.setAssistantInRound(round.id, { assistantMessages: [{ role: 'assistant', content: formatFlowOutput(output) }], result });
        } else {
            const status = root.status === 'failed' || root.status === 'cancelled' ? root.status
                : interactions.some(item => item.status === 'waiting_input') ? 'waiting' : 'running';
            await log.setConversationStatus(round.id, status, root.exit?.error?.message ?? root.lastError?.message, result);
        }
    }
}

export function runTasks(root: TaskRecord, tasks: TaskRecord[], members: string[]): TaskRecord[] {
    const input = record(root.input);
    const ids = new Set<string>([root.id, ...members, ...(input.runTasks ?? []).map((item: any) => item.taskId)]);
    // Scheduled nodes need not use the aggregate as parent; dependencies are the durable join membership.
    for (const dependency of record(root.state).dependencies ?? input.dependencies ?? []) if (dependency.taskId) ids.add(dependency.taskId);
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of tasks) if ((task.rootTaskId === root.id || (task.parentTaskId && ids.has(task.parentTaskId))) && !ids.has(task.id)) {
            ids.add(task.id); changed = true;
        }
    }
    return tasks.filter(task => ids.has(task.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function projectTaskInteractions(task: TaskRecord, events: EventEnvelope[] = [], translate: (key: SessionTextKey) => string = t): FlowInteraction[] {
    const status = flowTaskStatus(task), actor = flowActor(task);
    const result: FlowInteraction[] = events.flatMap(event => flowLogicInteraction(task, event, translate) ?? []);
    const input = ['flow.input', 'flow.human'].includes(task.program.kind);
    const answered = Object.values(task.interactions ?? {}).some(request => request.status === 'resolved');
    if (!['flow.dispatch', 'flow.aggregate', 'flow.value'].includes(task.program.kind) && (!input || (task.output !== undefined && !answered))) result.push({
        id: `flow-${task.id}`, taskId: task.id, name: actor.nodeName ?? task.program.kind, actor,
        role: ['flow.input', 'flow.human'].includes(task.program.kind) ? 'user' : 'assistant', status,
        content: task.output === undefined ? partialContent(task, events) : formatFlowOutput(task.output), createdAt: task.createdAt,
        thinking: taskThinking(task, events) || undefined,
        parallelGroup: task.labels?.flowHistoryGroup,
        requests: requestSnapshots(events),
        error: task.exit?.error?.message ?? task.lastError?.message,
    });
    result.push(...toolInteractions(task, events));
    for (const request of Object.values(task.interactions ?? {})) {
        const id = flowRequestId(task.id, request.id);
        result.push({ id, taskId: task.id, name: request.kind, role: 'assistant', actor: { ...actor, kind: request.kind },
            status: request.status === 'pending' ? 'waiting_input' : request.status === 'cancelled' ? 'aborted' : 'success',
            content: request.prompt, createdAt: request.requestedAt });
        if (request.status === 'resolved') result.push({ id: `${id}-response`, taskId: task.id, name: request.kind, role: 'user',
            actor: { ...actor, kind: request.kind }, status: 'success', content: outputText(request.response), createdAt: request.resolvedAt ?? request.requestedAt });
    }
    return result;
}

function requestSnapshots(events: EventEnvelope[]): FlowInteraction['requests'] {
    const requests = new Map<string, NonNullable<FlowInteraction['requests']>[number]>();
    for (const envelope of events) {
        const event = envelope.payload as AgentEvent;
        if (event.type !== 'llm:request') continue;
        const { type: _type, ...request } = event;
        requests.set(event.effectId, request);
    }
    return requests.size ? [...requests.values()] : undefined;
}

function taskThinking(task: TaskRecord, events: EventEnvelope[]): string {
    events = latestAttempts(events);
    const stream = events.map(event => event.payload as AgentEvent)
        .filter(event => event.type === 'stream:thinking').map(event => event.delta).join('');
    if (stream) return stream;
    const messages = record(task.state).messages ?? [];
    const thinking = messages.filter((message: any) => message.role === 'assistant' && typeof message.thinking === 'string')
        .map((message: any) => message.thinking).join('\n\n');
    return thinking || record(record(task.output).message).thinking || '';
}

function partialContent(task: TaskRecord, events: EventEnvelope[]): string {
    events = latestAttempts(events);
    const stream = events.map(event => event.payload as AgentEvent).filter(event => event.type === 'stream:content').map(event => event.delta).join('');
    if (stream) return stream;
    const messages = record(task.state).messages ?? [];
    return messages.filter((message: any) => message.role === 'assistant' && typeof message.content === 'string')
        .map((message: any) => message.content).join('\n\n');
}

function toolInteractions(task: TaskRecord, events: EventEnvelope[]): FlowInteraction[] {
    const messages = record(task.state).messages ?? [];
    const entries: FlowInteraction[] = messages.flatMap((message: any) => (message.tool_calls ?? []).map((call: any) => {
        const entry = flowToolInteraction(task, call.function?.name ?? call.name ?? 'tool', call.id);
        const response = messages.find((item: any) => item.role === 'tool' && item.tool_call_id === call.id);
        entry.input = call.function?.arguments;
        entry.content = response ? outputText(response.content) : '';
        entry.status = response ? 'success' : ['failed', 'aborted'].includes(flowTaskStatus(task)) ? flowTaskStatus(task) : 'running';
        return entry;
    }));
    for (const envelope of events) {
        const event = envelope.payload as AgentEvent;
        if (event.type !== 'tool:running' && event.type !== 'tool:queued' && event.type !== 'tool:success' && event.type !== 'tool:error') continue;
        let entry = entries.find(item => item.actor?.toolCallId === event.call.toolId);
        if (!entry) { entry = flowToolInteraction(task, event.call.name, event.call.toolId); entries.push(entry); }
        entry.input = event.call.input; entry.createdAt = envelope.occurredAt;
        if (event.type === 'tool:success') { entry.status = 'success'; entry.content = event.call.result; }
        else if (event.type === 'tool:error') { entry.status = 'failed'; entry.error = event.call.error; entry.content = event.call.error; }
    }
    for (const entry of entries) if (entry.status === 'running' && ['failed', 'aborted'].includes(flowTaskStatus(task))) entry.status = flowTaskStatus(task);
    return entries;
}

/** Drop partial text from failed attempts while keeping earlier successful exchanges. */
function latestAttempts(events: EventEnvelope[]): EventEnvelope[] {
    const result: EventEnvelope[] = [];
    let start = 0;
    for (const event of events) {
        if (event.type === 'agent.event' && (event.payload as AgentEvent).type === 'llm:request') start = result.length;
        if (event.type === 'effect.retry.scheduled' && String((event.payload as { effectId: string }).effectId).startsWith('llm-')) result.splice(start);
        else result.push(event);
    }
    return result;
}
