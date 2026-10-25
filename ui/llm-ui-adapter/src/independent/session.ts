import {InvocationOperations} from '../flows/invocation-operations';
import {ControlOperations} from '../flows/control-operations';
import {createImageChatView, type ImageChatOptions} from './image-chat-view';
import type {ImageEditingHost} from './image-editing';
import { type ConversationActions, type MessagePart,
    type OperationContext, type OperationLedger, type OperationReceipt, type SelectorView, type ComposerCommand, type CommandSubmission } from '@itookit/llm-ui';
import {getOperationCallInput, type ComposerInputContract, type ChatSubmission} from '@itookit/llm-ui';
import { createAgentSendIntent, type SessionSubmission } from '@itookit/llm-flow/contracts';
import {isTargetRef, type FlowCallSource} from '@itookit/llm-flow/contracts';
import {SessionCallTargets} from './session-targets';
import { SessionCommand, type ExecutionNode, type ICommandBus, type SubmissionRequest,
    type SessionGroup, type SessionViewPort } from '@itookit/llm-session/contracts';
import { ChatProjection } from './projection';

export interface SessionChatBindingOptions {
    readonly images?: ImageEditingHost;
    readonly session: SessionViewPort;
    readonly commands: ICommandBus;
    /** Hosts query committed evidence through the backend's hasCommittedSubmission. */
    readonly hasCommittedSubmission: (submission: SessionSubmission) => Promise<boolean>;
    readonly operations: OperationLedger;
    readonly title?: string;
    readonly selectors?: () => readonly SelectorView[];
    /** The host resolves the selected Agent's published Flow signature. */
    readonly inputContract?: () => ComposerInputContract | undefined;
    /** Enable the published Agent/Flow selector through the existing Session command port. */
    readonly targetSelection?: boolean;
    readonly subscribeInput?: (listener: () => void) => () => void;
    readonly composerCommands?: {
        getSnapshot(): readonly ComposerCommand[];
        execute(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt>;
        reconcile: NonNullable<ConversationActions['reconcile']>;
        subscribe?(listener: () => void): () => void;
    };
    readonly onError?: (error: unknown) => void;
}
/** Hosts own this binding; disposing it releases observation, never the Session or its tasks. */
export function createSessionChatBinding(options: SessionChatBindingOptions) {
    return new SessionChatBinding(options);
}
class SessionChatBinding {
    get images() {return this.options.images;}
    readonly source: ChatProjection;
    readonly actions: ConversationActions;
    readonly operations: OperationLedger;
    private readonly sessionId: string;
    private readonly branch?: string;
    private readonly releases: (() => void)[];
    private readonly confirmed = new Set<string>();
    private readonly queued = new Set<string>();
    private readonly checking = new Map<string, Promise<boolean>>();
    private readonly admissionChecks = new Map<string, Promise<boolean>>();
    private closed = false;
    private readonly targets?: SessionCallTargets;
    constructor(private readonly options: SessionChatBindingOptions) {
        this.sessionId = options.session.id;
        this.branch = options.session.getSnapshot?.().view?.manifest.currentBranch;
        this.operations = this.createLedger(options.operations);
        if (options.targetSelection) this.targets = new SessionCallTargets(options.commands, () => this.publish());
        this.source = new ChatProjection(this.sessionId, options.onError, this.targets ? () => this.refreshTargets() : undefined);
        this.actions = { send: (input, context) => this.send(input, context), reconcile: id => this.reconcile(id) };
        if (options.composerCommands) this.actions.command = (input, context) => this.command(input, context);
        this.releases = [options.session.onEvent(event => {
            if (this.current() && event?.type === 'instructions:changed') this.observeQueue(event.payload);
            this.publish();
        }), options.operations.subscribe(() => this.publish())];
        if (options.composerCommands?.subscribe) this.releases.push(options.composerCommands.subscribe(() => this.publish()));
        if (options.subscribeInput) this.releases.push(options.subscribeInput(() => this.publish()));
        this.publish();
        if (this.targets) void this.targets.refresh();
    }
    private createLedger(ledger: OperationLedger): OperationLedger {
        return {...ledger, register: record => {
            const input = record.input as unknown as ChatSubmission;
            if (record.kind !== 'send' || !input?.target) return ledger.register(record);
            const frozen = {...input, sessionRequest: this.targetRequest(input, record.context.operationId)};
            return ledger.register({...record, input: JSON.parse(JSON.stringify(frozen))});
        }};
    }
    private current(): boolean {
        return !this.closed && this.options.session.id === this.sessionId
            && this.options.session.getSnapshot?.().view?.manifest.currentBranch === this.branch;
    }
    private publish(): void {
        if (!this.current()) return;
        this.observeQueue(this.options.session.getSnapshot?.().instructionQueue);
        const messages = this.options.session.getSessions().map(group => projectGroup(group, this.operations, this.confirmed, this.sessionId));
        this.source.publish({ title: this.options.title ?? this.options.session.getSnapshot?.().view?.manifest.title ?? '',
            messages, interactions: [], selectors: this.options.selectors?.(), commands: this.options.composerCommands?.getSnapshot(),
            inputContract: this.options.inputContract?.(), loading: false,
            ...(this.targets ? {callTargets: this.targets.getSnapshot()} : {}),
            operationReceipts: this.operations.getSnapshot().filter(record => record.conversationId === this.sessionId && record.kind === 'send'
                && this.queued.has(record.context.operationId)).map(record => ({status: 'accepted', operationId: record.context.operationId})),
            execution: this.options.session.isGenerating() ? 'running' : 'idle', connection: 'online', hasEarlier: false,
            allowed: ['send', ...(this.options.composerCommands ? ['command' as const] : [])] });
        for (const message of messages) if (message.submissionId && !this.confirmed.has(message.submissionId)) {
            void this.check(message.submissionId).then(accepted => { if (accepted) this.publish(); }).catch(error => this.options.onError?.(error));
        }
    }
    private observeQueue(queue?: import('@itookit/llm-session/contracts').SessionInstructionQueue): void {
        if (queue?.sessionId !== this.sessionId) return;
        for (const item of queue.items) {
            const submission = item.sendIntent?.submission, expected = this.submission(item.id);
            if (this.queued.has(item.id) || submission?.id !== item.id || submission.source.kind !== expected.source.kind
                || submission.source.ownerId !== expected.source.ownerId || submission.source.id !== expected.source.id) continue;
            void this.checkAdmission(item.id).then(accepted => {if (accepted) this.publish();})
                .catch(error => this.options.onError?.(error));
        }
    }
    private checkAdmission(operationId: string): Promise<boolean> {
        if (this.queued.has(operationId)) return Promise.resolve(true);
        const existing = this.admissionChecks.get(operationId);
        if (existing) return existing;
        const record = this.operations.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send'
            && item.conversationId === this.sessionId);
        const input = record?.input as unknown as ChatSubmission | undefined;
        if (!input?.target) return Promise.resolve(false);
        const request = this.frozenRequest(operationId);
        const pending = this.options.commands.execute<import('@itookit/llm-session/contracts').SubmissionReceipt>(SessionCommand.InspectSubmissionReceipt,
            request).then(receipt => {
                if (!receipt || receipt.operationId !== operationId || !['accepted', 'unknown'].includes(receipt.status))
                    throw new Error('Submission receipt differs from the frozen request');
                if (receipt.status === 'accepted') this.queued.add(operationId);
                return receipt.status === 'accepted';
            }).finally(() => this.admissionChecks.delete(operationId));
        this.admissionChecks.set(operationId, pending); return pending;
    }
    private submission(operationId: string): SessionSubmission {
        return { id: operationId, source: { kind: 'conversation', ownerId: this.sessionId, id: operationId } };
    }
    private check(operationId: string): Promise<boolean> {
        if (this.confirmed.has(operationId)) return Promise.resolve(true);
        const previous = this.checking.get(operationId);
        if (previous) return previous;
        const pending = Promise.resolve().then(() => this.options.hasCommittedSubmission(this.submission(operationId)))
            .then(accepted => { if (accepted) this.confirmed.add(operationId); return accepted; })
            .finally(() => this.checking.delete(operationId));
        this.checking.set(operationId, pending); return pending;
    }
    private async send(input: Parameters<NonNullable<ConversationActions['send']>>[0], context: OperationContext): Promise<OperationReceipt> {
        if (!this.current() || context.viewId !== this.source.getSnapshot().viewId)
            return rejected(context, 'STALE_VIEW', 'Observation binding expired');
        const choice = input.target && this.targets?.find(input.target);
        if (this.targets && (!input.target || !choice)) return rejected(context, 'STALE_CALL_TARGET', 'Published call target changed; select it again');
        const contract = this.targets ? choice?.inputContract : this.options.inputContract?.();
        if (!validInputContract(input, contract))
            return rejected(context, 'STALE_INPUT_SIGNATURE', 'Target or input signature changed; review the arguments before sending');
        if (input.target) return this.submitTarget(input, context);
        const agentId = input.input?.targetId ?? input.selection?.agentId ?? 'default';
        await this.options.commands.execute(SessionCommand.Send, { text: input.text, agentId,
            ...(input.input ? {overrides: {flowParameters: structuredClone(input.input.values), flowExpectedSignature: {...input.input.signature}}} : {}),
            files: input.attachments.map(file => ({ name: file.name, type: file.mimeType ?? '', path: file.id })),
            sendIntent: { ...createAgentSendIntent(agentId), submission: this.submission(context.operationId) } });
        return this.reconcile(context.operationId);
    }
    private async submitTarget(input: ChatSubmission, context: OperationContext): Promise<OperationReceipt> {
        const target = input.target;
        if (!this.targets || !isTargetRef(target)) return rejected(context, 'INVALID_CALL_TARGET', 'Unsupported call target');
        await this.options.commands.execute(SessionCommand.Submit, this.frozenRequest(context.operationId));
        return this.reconcile(context.operationId);
    }
    private frozenRequest(operationId: string): SubmissionRequest {
        const record = this.operations.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send'
            && item.conversationId === this.sessionId);
        const request = (record?.input as {sessionRequest?: SubmissionRequest} | undefined)?.sessionRequest;
        if (request?.expectedSessionId !== this.sessionId || request.submission?.id !== operationId)
            throw Object.assign(new Error('Frozen submission context is unavailable'), {code: 'SUBMISSION_CONTEXT_MISSING'});
        return structuredClone(request);
    }
    private targetRequest(input: ChatSubmission, operationId: string): import('@itookit/llm-session/contracts').SubmissionRequest {
        const target = input.target!;
        if (!isTargetRef(target)) throw Object.assign(new Error('Invalid frozen call target'), {code: 'SUBMISSION_TARGET_INVALID'});
        const source = {kind: 'composer', text: input.text, attachments: input.attachments.map(file => ({...file})),
            values: structuredClone(input.input?.values ?? {})} as FlowCallSource;
        return {expectedSessionId: this.sessionId, expectedBranch: this.branch, target: {kind: target.kind, id: target.id, version: target.version}, expectedTarget: {...target}, source,
            attachments: input.attachments.map(file => ({name: file.name, type: file.mimeType ?? '', path: file.id})),
            ...(input.input ? {overrides: {flowExpectedSignature: {...input.input.signature,
                id: input.input.signature.id as import('@itookit/llm-flow/contracts').FlowId}}} : {}), submission: this.submission(operationId)};
    }
    private command(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt> {
        if (!this.current() || context.viewId !== this.source.getSnapshot().viewId)
            return Promise.resolve(rejected(context, 'STALE_VIEW', 'Observation binding expired'));
        const target = this.options.composerCommands?.getSnapshot().find(command => command.id === input.target.id
            && command.revision === input.target.expectedRevision && command.kind === input.kind && !command.disabled);
        return target ? this.options.composerCommands!.execute(input, context)
            : Promise.resolve(rejected(context, 'STALE_COMMAND', 'Command changed or is unavailable'));
    }
    private async reconcile(operationId: string): Promise<OperationReceipt> {
        const invocations = new InvocationOperations(this.operations, this.options.commands, this.sessionId);
        if (invocations.has(operationId)) return invocations.reconcile(operationId);
        const controls = new ControlOperations(this.operations, this.options.commands, this.sessionId);
        if (controls.has(operationId)) return controls.reconcile(operationId);
        if (this.operations.getSnapshot().some(record => record.context.operationId === operationId && record.kind === 'command') && this.options.composerCommands)
            return this.options.composerCommands.reconcile(operationId);
        const record = this.operations.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send');
        if ((record?.input as ChatSubmission | undefined)?.target)
            return await this.checkAdmission(operationId) ? {status: 'accepted', operationId}
                : {status: 'unknown', operationId, message: 'No durable admission evidence is visible yet'};
        if (await this.check(operationId)) {
            this.publish(); return { status: 'accepted', operationId };
        }
        return { status: 'unknown', operationId, message: 'No committed submission evidence is visible yet' };
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true; this.releases.forEach(release => release());
        this.targets?.dispose();
    }
    refreshTargets(): Promise<void> {return this.targets?.refreshCurrent() ?? Promise.resolve();}
}
function validInputContract(input: ChatSubmission, contract?: ComposerInputContract): boolean {
    if (!input.input) return !contract;
    const {targetId, signature} = input.input;
    const selected = input.selection?.targetId ?? input.selection?.agentId;
    const expected = input.input.target, actual = contract?.target;
    const sameTarget = !actual || !expected ? actual === expected : actual.kind === expected.kind && actual.id === expected.id
        && actual.version === expected.version && actual.digest === expected.digest;
    return !!contract && sameTarget && (!selected || selected === targetId) && targetId === contract.targetId
        && signature.id === contract.signature.id && signature.revision === contract.signature.revision && signature.digest === contract.signature.digest;
}
export async function createSessionChatView(container: HTMLElement, binding: ReturnType<typeof createSessionChatBinding>,
    options: ImageChatOptions = {}) {
    return createImageChatView(container, {...options, source: binding.source, actions: binding.actions, operations: binding.operations}, options.images ?? binding.images);
}
function rejected(context: OperationContext, code: string, message: string): OperationReceipt {
    return { status: 'rejected', operationId: context.operationId, code, message };
}
function projectGroup(group: SessionGroup, ledger: OperationLedger, confirmed: ReadonlySet<string>, sessionId: string) {
    const operation = ledger.getSnapshot().find(record => (record.kind === 'send' || record.kind === 'command') && record.conversationId === sessionId
        && group.id === `round-${record.context.operationId}-user`);
    const parts: MessagePart[] = group.role === 'user' ? [{ id: 'body', kind: 'markdown', text: group.content ?? '' }]
        : projectNode(group.executionRoot);
    const input = group.role === 'user' ? group.callInput?.admitted?.parameters ?? getOperationCallInput(operation)?.values : undefined;
    if (input) parts.push({id: 'arguments', kind: 'json', value: input});
    for (const [index, file] of (group.files ?? []).entries()) parts.push({ id: `attachment-${index}`, kind: 'attachment',
        file: { id: file.path ?? file.name, name: file.name, mimeType: file.type } });
    return { id: group.id, revision: 0, role: group.role, parts, timestamp: group.timestamp,
        state: group.executionRoot?.status === 'running' ? 'streaming' as const : 'complete' as const,
        submissionId: operation?.context.operationId,
        acceptance: operation && !confirmed.has(operation.context.operationId) ? 'optimistic' as const : 'confirmed' as const };
}
function projectNode(node?: ExecutionNode): MessagePart[] {
    if (!node) return [];
    const parts: MessagePart[] = [];
    if (node.executorType === 'tool') parts.push({ id: node.id, kind: 'tool', name: node.name,
        summary: node.data.toolCall?.name ?? node.name, detail: node.data.error ?? node.data.output,
        state: node.status === 'running' ? 'running' : node.status === 'failed' ? 'failed' : 'succeeded' });
    else {
        if (node.data.thought) parts.push({ id: `${node.id}-thought`, kind: 'reasoning', text: node.data.thought });
        if (node.data.output) parts.push({ id: node.id, kind: 'markdown', text: node.data.output });
    }
    return [...parts, ...(node.children ?? []).flatMap(projectNode)];
}
