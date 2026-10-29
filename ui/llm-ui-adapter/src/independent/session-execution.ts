import {taskInputParameters} from '../flows/task-input-parameters';
import {createModuleLogger, t} from '@itookit/common';
import type {EditorTaskControlPlane, InteractionRecord, JsonValue, TaskRecord} from '@itookit/durable-kernel/contracts';
import type {ConversationActions, InteractionView, OperationContext, OperationLedger, OperationReceipt} from '@itookit/llm-ui';
import type {SessionGroup} from '@itookit/llm-session/contracts';
import {agentQuestionAnswer, agentQuestionFields} from '../components/input/agent-questions';

const terminal = (task: TaskRecord) => ['succeeded', 'failed', 'cancelled'].includes(task.status);
const log = createModuleLogger('session-chat-execution');
/** Observe only executions belonging to this fixed branch; Kernel owns every transition. */
export class SessionExecution {
    private tasks: TaskRecord[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private reading?: Promise<void>;
    private active = true;
    private closed = false;
    constructor(private kernel: EditorTaskControlPlane, private sessionId: string, private groups: () => readonly SessionGroup[],
        private current: () => boolean, private changed: () => void, private failed: (error: unknown) => void, private readonly structuredInputDialog = false) {}
    private roots(): Set<string> {return new Set(this.groups().flatMap(group => group.execution ? [group.execution.taskId] : []));}
    private owns(task: TaskRecord): boolean {const roots = this.roots(); return task.sessionId === this.sessionId && (roots.has(task.id) || roots.has(task.rootTaskId));}
    private usable(): boolean {return !this.closed && this.active && this.current();}
    get executionRef(): string | undefined {
        const roots = this.roots(), task = [...this.tasks].reverse().find(task => roots.has(task.id) && !terminal(task));
        return task ? JSON.stringify([task.id, task.control?.epoch ?? 0]) : undefined;
    }
    get running(): boolean {return this.tasks.some(task => !terminal(task) && this.owns(task));}
    get waiting(): boolean {return this.tasks.some(task => !terminal(task) && this.owns(task) && Object.values(task.interactions).some(item => item.status === 'pending'));}
    get interactions(): InteractionView[] {
        return this.tasks.filter(task => !terminal(task) && this.owns(task)).flatMap(task => Object.values(task.interactions)
            .filter(request => request.status === 'pending' && !(this.structuredInputDialog && taskInputParameters(request))).map(request => projectInteraction(task.id, request)));
    }
    refresh(): Promise<void> {
        if (!this.usable()) return Promise.resolve();
        if (!this.roots().size) {clearTimeout(this.timer); if (this.tasks.length) {this.tasks = []; this.changed();} return Promise.resolve();}
        return this.reading ??= this.read().finally(() => {this.reading = undefined;});
    }
    private async read(): Promise<void> {
        clearTimeout(this.timer); const started = Date.now();
        try {
            const tasks = await this.kernel.listSessionTasks(this.sessionId);
            if (!this.usable()) return;
            this.tasks = tasks.filter(task => this.owns(task)); this.changed();
        } catch (error) {if (this.usable()) {trace('observe', '', started, error); this.failed(error);}}
        finally {if (this.usable() && this.tasks.some(task => !terminal(task))) this.timer = setTimeout(() => {void this.refresh();}, 1500);}
    }
    async cancel(executionRef: string, context: OperationContext): Promise<OperationReceipt> {
        const [taskId, epoch] = JSON.parse(executionRef) as [string, number];
        return this.run(context, 'cancel', async () => {
            const handle = await this.kernel.openTask(taskId), task = (await handle.status()).task;
            if (!this.usable() || !this.roots().has(taskId) || !this.owns(task) || terminal(task) || (task.control?.epoch ?? 0) !== epoch)
                throw Object.assign(new Error('Execution changed; refresh before stopping'), {code: 'STALE_EXECUTION'});
            await handle.cancel('Cancelled from conversation', {requestId: context.operationId, expectedEpoch: epoch});
        });
    }
    async respond(input: Parameters<NonNullable<ConversationActions['respond']>>[0], context: OperationContext): Promise<OperationReceipt> {
        const [taskId, interactionId] = JSON.parse(input.id) as [string, string];
        return this.run(context, 'respond', async () => {
            const handle = await this.kernel.openTask(taskId), task = (await handle.status()).task;
            const request = task.interactions[interactionId];
            if (!this.usable() || !this.owns(task) || terminal(task) || request?.status !== 'pending' || request.requestedAt !== input.revision)
                throw Object.assign(new Error('Interaction changed; refresh before answering'), {code: 'STALE_INTERACTION'});
            if (request.kind !== input.response.kind) throw new Error('Interaction response kind differs');
            if (input.response.kind === 'approval' && !['approved', 'rejected'].includes(input.response.decisionId))
                throw new Error('Unknown approval decision');
            const payload = payloadOf(request), fields = agentQuestionFields(payload.questions);
            const value: JsonValue = input.response.kind === 'approval'
                ? {approved: input.response.decisionId === 'approved', ...(input.response.note ? {note: input.response.note} : {})}
                : fields.length ? agentQuestionAnswer(fields, input.response) : plainAnswer(input.response, payload);
            await handle.respond({interactionId, value}, {requestId: context.operationId});
        });
    }
    async reconcile(operationId: string, ledger: OperationLedger): Promise<OperationReceipt> {
        const record = ledger.getSnapshot().find(item => item.context.operationId === operationId && item.conversationId === this.sessionId);
        if (record?.status === 'accepted') return {operationId, status: 'accepted'};
        if (record?.kind === 'respond') {
            const input = record.input as unknown as {id: string; revision: number};
            const [taskId, interactionId] = JSON.parse(input.id) as [string, string];
            const task = (await (await this.kernel.openTask(taskId)).status()).task;
            const request = task.interactions[interactionId];
            if (task.sessionId === this.sessionId && request?.responseRequestId === operationId && request.requestedAt === input.revision)
                return {operationId, status: 'accepted'};
        }
        // A terminal task alone cannot prove admission of this specific cancellation.
        return {operationId, status: 'unknown', message: t('chat.submission.unconfirmed')};
    }
    private async run(context: OperationContext, stage: string, action: () => Promise<void>): Promise<OperationReceipt> {
        const started = Date.now();
        try {await action(); trace(stage, context.operationId, started); void this.refresh(); return {operationId: context.operationId, status: 'accepted'};}
        catch (error) {trace(stage, context.operationId, started, error); throw error;}
    }
    setActive(active: boolean): void {this.active = active; clearTimeout(this.timer); if (active) void this.refresh();}
    dispose(): void {this.closed = true; clearTimeout(this.timer); this.tasks = [];}
}
function payloadOf(request: InteractionRecord<JsonValue>): Record<string, JsonValue> {
    return request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {};
}
function projectInteraction(taskId: string, request: InteractionRecord<JsonValue>): InteractionView {
    const payload = payloadOf(request), fields = agentQuestionFields(payload.questions);
    const base = {id: JSON.stringify([taskId, request.id]), revision: request.requestedAt, title: request.prompt, state: 'pending' as const,
        detail: request.payload === undefined ? undefined : JSON.stringify(request.payload, null, 2)};
    if (request.kind === 'approval') return {...base, kind: 'approval', note: true,
        decisions: [{id: 'approved', label: t('chatInput.interaction.approve')}, {id: 'rejected', label: t('chatInput.interaction.reject')}]};

    return {...base, kind: 'input', fields: fields.length ? fields : [{id: 'answer', kind: 'text', multiline: true, label: payload.fields ? t('callable.independent.answer.json') : t('chatInput.interaction.answer'), required: true}]};
}
function plainAnswer(response: Extract<import('@itookit/llm-ui').InteractionResponse, {kind: 'input'}>, payload: Record<string, JsonValue>): JsonValue {
    const text = String(response.values.answer ?? '');
    if (!payload.fields) return text;
    try {const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value;}
    catch { /* Keep the question pending until the user supplies valid JSON. */ }
    throw Object.assign(new Error(t('callable.independent.answer.invalidJson')), {code: 'INTERACTION_JSON_REQUIRED'});
}
function trace(stage: string, operationId: string, started: number, error?: unknown): void {
    const code = (error as {code?: string})?.code;
    try {const data = {stage, operationId, result: error ? 'failure' : 'success', durationMs: Date.now() - started,
        ...(error ? {code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SESSION_CONTROL_FAILED'} : {})};
        if (error) log.warn('session.execution', data); else log.info('session.execution', data);
    } catch { /* Control results do not depend on diagnostics. */ }
}
