import {flowNodeDocument} from './flow-node-document';
import {messageOutputs, outputRenderer} from './message-outputs';
import {SessionExecution} from './session-execution';
import {messageState, toolState} from './message-state';
import {verifyInputContext} from '../services/verify-input-context';
import {prepareInputContextDraft} from '../domain/context-draft';
import type {ContextOptionsQuery, ContextOptionsPage} from '@itookit/llm-session/contracts';
import type {InteractionDraftStorage} from '../domain/interaction-draft';
import {CallControlOperations} from './call-control';
import {SessionCallPresentation} from './session-calls';
import {createModuleLogger, t} from '@itookit/common';
import {IndependentCallCommand, type IndependentCallReceipt} from '@itookit/llm-session/contracts';
import {InvocationOperations} from '../flows/invocation-operations';
import {ControlOperations} from '../flows/control-operations';
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

const independentLog = createModuleLogger('independent-chat-admission');

export interface SessionChatBindingOptions {
    readonly prepareSend?: ConversationActions['prepareSend'];
    readonly resolveSubmission?: (operationId: string) => SessionSubmission | undefined;
    readonly openOutputs?: (taskId: string) => void | Promise<void>;
    readonly prepareRequest?: (request: SubmissionRequest, input: ChatSubmission) => Promise<SubmissionRequest>;
    readonly prepareAttachments?: (input: ChatSubmission, operationId: string) => Promise<NonNullable<SubmissionRequest['attachments']>>;
    readonly executionOverrides?: (input: ChatSubmission) => SubmissionRequest['overrides'];
    readonly kernel?: import('@itookit/durable-kernel/contracts').EditorTaskControlPlane;
    readonly readOnly?: boolean;
    readonly instructionQueue?: boolean;
    readonly contextSelection?: boolean;
    readonly interactionDrafts?: InteractionDraftStorage;
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
    /** Offer independent calls for published targets; the host keeps all execution state. */
    readonly independentCalls?: boolean;
    readonly openChild?: (sessionId: string) => void | Promise<void>;
    /** Current host-observed branch when the Session snapshot omits its loaded view. */
    readonly branch?: () => string | undefined;
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
    private active = true;
    private presentation?: SessionCallPresentation;
    private execution?: SessionExecution;
    private admissionTimer?: ReturnType<typeof setTimeout>;
    private readonly targets?: SessionCallTargets;
    constructor(private readonly options: SessionChatBindingOptions) {
        this.sessionId = options.session.id;
        this.branch = this.currentBranch();
        this.operations = this.createLedger(options.operations);
        if (options.targetSelection) this.targets = new SessionCallTargets(options.commands, () => this.publish());
        this.source = new ChatProjection(this.sessionId, options.onError, this.targets ? () => this.refreshTargets() : undefined);
        this.actions = { send: (input, context) => this.send(input, context), reconcile: id => this.reconcile(id) };
        if (options.prepareSend) this.actions.prepareSend = options.prepareSend;
        if (options.kernel) {
            this.execution = new SessionExecution(options.kernel, this.sessionId, () => options.session.getSessions(),
                () => this.current() && !options.readOnly, () => this.publish(), error => options.onError?.(error));
            const allowed = (context: OperationContext) => !options.readOnly && this.active && this.current() && context.viewId === this.source.getSnapshot().viewId;
            this.actions.cancel = (ref, context) => allowed(context) ? this.execution!.cancel(ref, context) : Promise.resolve(rejected(context, 'STALE_VIEW', 'Execution control unavailable'));
            this.actions.respond = (input, context) => allowed(context) ? this.execution!.respond(input, context) : Promise.resolve(rejected(context, 'STALE_VIEW', 'Interaction control unavailable'));
        }
        if (options.composerCommands) this.actions.command = (input, context) => this.command(input, context);
        this.releases = [options.session.onEvent(event => {
            if (this.current() && event?.type === 'instructions:changed') this.observeQueue(event.payload);
            this.publish(); void this.execution?.refresh();
        }), options.operations.subscribe(() => {this.publish(); this.scheduleIndependentAdmission();})];
        if (options.composerCommands?.subscribe) this.releases.push(options.composerCommands.subscribe(() => this.publish()));
        if (options.subscribeInput) this.releases.push(options.subscribeInput(() => this.publish()));
        this.publish();
        if (this.targets) void this.targets.refresh();
        void this.execution?.refresh();
        this.scheduleIndependentAdmission();
    }
    private createLedger(ledger: OperationLedger): OperationLedger {
        return {...ledger, getSnapshot: () => ledger.getSnapshot().filter(record => {
            const value = record.input as {sessionRequest?: SubmissionRequest; request?: SubmissionRequest} | null;
            const branch = value?.sessionRequest?.expectedBranch ?? value?.request?.expectedBranch;
            return record.conversationId !== this.sessionId || branch === undefined || branch === this.branch;
        }), register: async record => {
            const input = record.input as unknown as ChatSubmission;
            if (record.kind !== 'send') return ledger.register(record);
            if (!this.current() || this.options.readOnly) throw Object.assign(new Error('Session input is unavailable'), {code: 'SESSION_INPUT_UNAVAILABLE'});
            const independent = input?.selection?.callMode === 'independent';
            if (independent && (!this.options.independentCalls || !input.target)) throw new Error('Independent calls require an enabled published target');
            if (independent && !this.branch) throw Object.assign(new Error('Independent calls require an observed branch'), {code: 'CALL_BRANCH_REQUIRED'});
            if (input.context !== undefined && (!this.options.contextSelection || !input.target))
                throw Object.assign(new Error('Context selection requires a published target and host support'), {code: 'CONTEXT_SELECTION_UNAVAILABLE'});
            if (!input?.target) return ledger.register(record);
            let request = this.targetRequest(input, record.context.operationId);
            if (this.options.prepareRequest) request = await this.options.prepareRequest(request, input);
            if (request.expectedSessionId !== this.sessionId || request.expectedBranch !== this.branch || request.submission?.id !== record.context.operationId)
                throw new Error('Prepared submission identity differs from the frozen view');
            if (this.options.prepareAttachments) request.attachments = await this.options.prepareAttachments(input, record.context.operationId);
            if (!this.current() || this.options.readOnly) throw Object.assign(new Error('Session binding changed while preparing input'), {code: 'STALE_VIEW'});
            const frozen = {...input, ...(input.input && request.source.kind === 'arguments' ? {input: {...input.input, values: request.source.value}} : {}), sessionRequest: request,
                ...(independent ? {independentTitle: input.target.id} : {})};
            const captured = JSON.parse(JSON.stringify(frozen));
            if (!ledger.getSnapshot().some(item => item.context.operationId === record.context.operationId))
                await verifyInputContext(captured.context, query => this.readContextOptions(query), record.context.operationId);
            return ledger.register({...record, input: captured});
        }};
    }
    private currentBranch(): string | undefined {return this.options.branch?.() ?? this.options.session.getSnapshot?.().view?.manifest.currentBranch;}
    private current(): boolean {
        return !this.closed && this.options.session.id === this.sessionId
            && this.currentBranch() === this.branch;
    }
    private publish(): void {
        if (!this.current()) {
            this.presentation?.setActive(false);
            if (!this.closed) this.source.publish({...this.source.getSnapshot(), allowed: [], interactions: [],
                error: {code: 'STALE_VIEW', message: t('callable.submission.unavailable')}});
            return;
        }
        this.observeQueue(this.options.session.getSnapshot?.().instructionQueue);
        const groups = this.options.session.getSessions();
        const projected = groups.flatMap(group => splitUserMessages(group, projectGroup(group, this.operations, this.confirmed, this.sessionId, !!this.options.openOutputs)));
        const messages = this.presentation?.merge(projected, groups) ?? projected;
        this.source.publish({ title: this.options.title ?? this.options.session.getSnapshot?.().view?.manifest.title ?? '',
            messages, interactions: this.execution?.interactions ?? [], selectors: this.selectors(), commands: this.options.composerCommands?.getSnapshot(),
            inputContract: this.options.inputContract?.(), loading: false,
            ...(this.targets ? {callTargets: this.targets.getSnapshot()} : {}),
            operationReceipts: this.operations.getSnapshot().filter(record => record.conversationId === this.sessionId && record.kind === 'send'
                && this.queued.has(record.context.operationId)).map(record => ({status: 'accepted', operationId: record.context.operationId})),
            executionRef: this.execution?.executionRef,
            execution: this.execution?.interactions.length ? 'waiting-input' : this.options.session.isGenerating() ? 'running' : 'idle', connection: 'online', hasEarlier: false,
            allowed: this.options.readOnly ? [] : ['send', ...(this.execution?.executionRef ? ['cancel' as const] : []),
                ...(this.execution?.interactions.some(item => item.kind !== 'unsupported') ? ['respond' as const] : []), ...(this.options.composerCommands ? ['command' as const] : [])] });
        for (const message of messages) if (message.submissionId && !this.confirmed.has(message.submissionId)) {
            void this.check(message.submissionId).then(accepted => { if (accepted) this.publish(); }).catch(error => this.options.onError?.(error));
        }
    }
    private observeQueue(queue?: import('@itookit/llm-session/contracts').SessionInstructionQueue): void {
        if (queue?.sessionId !== this.sessionId) return;
        for (const item of queue.items) {
            const submission = item.sendIntent?.submission, expected = this.submission(item.id);
            if (this.independentTitle(item.id)) continue;
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
        const record = this.options.operations.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send'
            && item.conversationId === this.sessionId);
        const input = record?.input as unknown as ChatSubmission | undefined;
        if (!input?.target && !(input as {request?: SubmissionRequest} | undefined)?.request?.target) return Promise.resolve(false);
        const request = this.frozenRequest(operationId);
        const title = this.independentTitle(operationId), started = Date.now();
        const pending = this.options.commands.execute<import('@itookit/llm-session/contracts').SubmissionReceipt>(
            title ? IndependentCallCommand.Inspect : SessionCommand.InspectSubmissionReceipt,
            title ? {request, title} : request).then(receipt => {
                if (title) assertIndependentReceipt(receipt as IndependentCallReceipt, this.sessionId);
                if (!receipt || receipt.operationId !== operationId || !['accepted', 'unknown'].includes(receipt.status))
                    throw new Error('Submission receipt differs from the frozen request');
                if (receipt.status === 'accepted') this.queued.add(operationId);
                return receipt.status === 'accepted';
            }).catch(error => {if (title) logIndependentRead(error, operationId, started); throw error;})
            .finally(() => {if (this.admissionChecks.get(operationId) === pending) this.admissionChecks.delete(operationId);});
        this.admissionChecks.set(operationId, pending); return pending;
    }
    private submission(operationId: string): SessionSubmission {
        const record = this.options.operations.getSnapshot().find(item => item.context.operationId === operationId && item.conversationId === this.sessionId);
        const input = record?.input as {sessionRequest?: SubmissionRequest; request?: SubmissionRequest} | undefined;
        const prepared = this.options.resolveSubmission?.(operationId);
        if (prepared && prepared.id !== operationId) throw new Error('Prepared submission identity differs from the operation');
        return input?.sessionRequest?.submission ?? input?.request?.submission ?? prepared
            ?? { id: operationId, source: { kind: 'conversation', ownerId: this.sessionId, id: operationId } };
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
        if (this.options.readOnly) return rejected(context, 'READ_ONLY', 'Conversation is read-only');
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
        const request = this.frozenRequest(context.operationId), title = this.independentTitle(context.operationId);
        if (title) {
            const receipt = await this.options.commands.execute<IndependentCallReceipt>(IndependentCallCommand.Submit, {request, title});
            assertIndependentReceipt(receipt, this.sessionId);
            if (receipt.operationId !== context.operationId) throw new Error('Independent call operation identity mismatch');
            if (receipt.status === 'accepted') {this.queued.add(context.operationId); this.publish(); return {status: 'accepted', operationId: context.operationId};}
        } else await this.options.commands.execute(SessionCommand.Submit, request);
        return this.reconcile(context.operationId);
    }
    private selectors(): readonly SelectorView[] | undefined {
        const selectors = this.options.selectors?.() ?? [];
        if (!this.options.independentCalls || !this.targets) return selectors;
        return [...selectors, {id: 'callMode', label: t('callable.independent.mode'), value: 'current', choices: [
            {id: 'current', label: t('callable.independent.current')}, {id: 'independent', label: t('callable.independent.run')}]}];
    }
    private independentTitle(operationId: string): string | undefined {
        const record = this.options.operations.getSnapshot().find(item => item.context.operationId === operationId
            && item.kind === 'send' && item.conversationId === this.sessionId);
        return (record?.input as {independentTitle?: string} | undefined)?.independentTitle;
    }
    private pendingIndependent() {
        return this.operations.getSnapshot().filter(record => record.conversationId === this.sessionId && record.kind === 'send'
            && ['submitting', 'unknown'].includes(record.status) && !this.queued.has(record.context.operationId)
            && this.independentTitle(record.context.operationId)
            && (record.input as {sessionRequest?: SubmissionRequest}).sessionRequest?.expectedBranch === this.branch);
    }
    private scheduleIndependentAdmission(): void {
        clearTimeout(this.admissionTimer);
        if (this.presentation || !this.pendingIndependent().length) return;
        if (!this.closed && this.active) this.admissionTimer = setTimeout(() => {void this.observeIndependentAdmission();}, 1000);
    }
    private async observeIndependentAdmission(): Promise<void> {
        if (!this.current() || !this.active) return;
        const pending = this.pendingIndependent();
        try {
            await Promise.all(pending.map(record => this.checkAdmission(record.context.operationId)
                .catch(error => {this.options.onError?.(error); return false;})));
            if (this.current() && this.active) this.publish();
        } finally {this.scheduleIndependentAdmission();}
    }
    setActive(active: boolean): void {this.active = active; this.execution?.setActive(active); this.admissionChecks.clear(); this.presentation?.setActive(active && this.current()); this.scheduleIndependentAdmission();}
    private frozenRequest(operationId: string): SubmissionRequest {
        const record = this.options.operations.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send'
            && item.conversationId === this.sessionId);
        const input = record?.input as {sessionRequest?: SubmissionRequest; request?: SubmissionRequest} | undefined;
        const request = input?.sessionRequest ?? input?.request;
        if (request?.expectedSessionId !== this.sessionId || request.submission?.id !== operationId)
            throw Object.assign(new Error('Frozen submission context is unavailable'), {code: 'SUBMISSION_CONTEXT_MISSING'});
        return structuredClone(request);
    }
    private targetRequest(input: ChatSubmission, operationId: string): import('@itookit/llm-session/contracts').SubmissionRequest {
        const target = input.target!;
        if (!isTargetRef(target)) throw Object.assign(new Error('Invalid frozen call target'), {code: 'SUBMISSION_TARGET_INVALID'});
        const context = prepareInputContextDraft(input.context, {sessionId: this.sessionId, branchId: this.branch, target});
        const source = {kind: 'composer', text: input.text, attachments: input.attachments.map(file => ({...file})),
            values: structuredClone(input.input?.values ?? {})} as FlowCallSource;
        return {expectedSessionId: this.sessionId, expectedBranch: this.branch, target: {kind: target.kind, id: target.id, version: target.version}, expectedTarget: {...target}, source,
            attachments: input.attachments.map(file => ({name: file.name, type: file.mimeType ?? '', path: file.id})),
            ...(input.input || context || this.options.executionOverrides ? {overrides: {...this.options.executionOverrides?.(input), ...(context ? {harnessConversation: context.selection} : {}),
                ...(input.input ? {flowExpectedSignature: {...input.input.signature,
                    id: input.input.signature.id as import('@itookit/llm-flow/contracts').FlowId}} : {})}} : {}), submission: this.submission(operationId)};
    }
    private command(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt> {
        if (this.options.readOnly) return Promise.resolve(rejected(context, 'READ_ONLY', 'Conversation is read-only'));
        if (!this.current() || context.viewId !== this.source.getSnapshot().viewId)
            return Promise.resolve(rejected(context, 'STALE_VIEW', 'Observation binding expired'));
        const target = this.options.composerCommands?.getSnapshot().find(command => command.id === input.target.id
            && command.revision === input.target.expectedRevision && command.kind === input.kind && !command.disabled);
        return target ? this.options.composerCommands!.execute(input, context)
            : Promise.resolve(rejected(context, 'STALE_COMMAND', 'Command changed or is unavailable'));
    }
    private async reconcile(operationId: string): Promise<OperationReceipt> {
        const ledger = this.options.operations;
        const action = ledger.getSnapshot().find(record => record.conversationId === this.sessionId && record.context.operationId === operationId);
        if (this.execution && (action?.kind === 'cancel' || action?.kind === 'respond')) return this.execution.reconcile(operationId, ledger);
        const callControls = new CallControlOperations(ledger, this.options.commands, this.sessionId);
        if (callControls.has(operationId)) return callControls.reconcile(operationId);
        const invocations = new InvocationOperations(ledger, this.options.commands, this.sessionId);
        if (invocations.has(operationId)) return invocations.reconcile(operationId);
        const controls = new ControlOperations(ledger, this.options.commands, this.sessionId);
        if (controls.has(operationId)) return controls.reconcile(operationId);
        if (ledger.getSnapshot().some(record => record.context.operationId === operationId && record.kind === 'command') && this.options.composerCommands)
            return this.options.composerCommands.reconcile(operationId);
        const record = ledger.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send' && item.conversationId === this.sessionId);
        if ((record?.input as ChatSubmission | undefined)?.target || (record?.input as {request?: SubmissionRequest} | undefined)?.request?.target)
            return await this.checkAdmission(operationId) ? {status: 'accepted', operationId}
                : {status: 'unknown', operationId, message: 'No durable admission evidence is visible yet'};
        if (await this.check(operationId)) {
            this.publish(); return { status: 'accepted', operationId };
        }
        return { status: 'unknown', operationId, message: 'No committed submission evidence is visible yet' };
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true; this.execution?.dispose(); this.presentation?.destroy(); clearTimeout(this.admissionTimer); this.releases.forEach(release => release());
        this.targets?.dispose();
    }
    async refreshTargets(): Promise<void> {await this.targets?.refreshCurrent(); await this.presentation?.refresh();}
    get outputsRenderer() {return this.options.openOutputs ? outputRenderer(async taskId => {if (this.current() && this.active) await this.options.openOutputs!(taskId);}) : undefined;}
    get instructionQueue() {
        if (!this.options.instructionQueue) return undefined;
        return {commands: this.options.commands, sessionId: this.sessionId,
            current: () => !this.options.readOnly && this.active && this.current(),
            snapshot: () => this.current() ? this.options.session.getSnapshot?.().instructionQueue : undefined};
    }
    get contextSelection(): boolean {return !!this.options.contextSelection;}
    contextScope() {return this.current() && this.branch ? {sessionId: this.sessionId, branchId: this.branch} : undefined;}
    readContextOptions(query: ContextOptionsQuery): Promise<ContextOptionsPage> {return this.options.commands.execute(SessionCommand.ContextOptions, query);}
    mountCalls(): SessionCallPresentation | undefined {
        if (!this.options.independentCalls || !this.branch || this.closed || this.options.readOnly) return;
        if (this.presentation) throw new Error('The Session binding already owns a call presentation');
        clearTimeout(this.admissionTimer);
        this.presentation = new SessionCallPresentation(this.options.commands, this.sessionId, () => this.branch!, this.operations,
            () => this.publish(), this.options.openChild, this.options.interactionDrafts);
        if (!this.active || !this.current()) this.presentation.setActive(false);
        return this.presentation;
    }
    releaseCalls(presentation?: SessionCallPresentation): void {
        if (!presentation || this.presentation !== presentation) return;
        presentation.destroy(); this.presentation = undefined; this.publish(); this.scheduleIndependentAdmission();
    }
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
export {createRetainedSessionChatView as createSessionChatView} from './session-view';
export type {SessionChatView} from './session-view';

function splitUserMessages(group: SessionGroup, message: import('@itookit/llm-ui').ChatMessage): import('@itookit/llm-ui').ChatMessage[] {
    if (group.role !== 'user' || !group.inputMessages || group.inputMessages.length < 2) return [message];
    return group.inputMessages.map((input, index, inputs) => ({...message, id: `${group.id}:input:${index}`,
        ...(index === inputs.length - 1 ? {} : {submissionId: undefined}),
        parts: [{id: 'body', kind: 'markdown', text: typeof input.content === 'string' ? input.content : JSON.stringify(input.content)},
            ...((index === inputs.length - 1 ? message.parts : []).filter(part => part.kind === 'json')),
            ...(input.attachments ?? []).map((attachment, number) => ({id: `attachment-${number}`, kind: 'attachment' as const,
                file: {id: typeof attachment.source === 'string' ? attachment.source : attachment.name ?? attachment.filename ?? '',
                    name: attachment.name ?? attachment.filename ?? '', mimeType: attachment.mimeType}}))]}));
}
function rejected(context: OperationContext, code: string, message: string): OperationReceipt {
    return { status: 'rejected', operationId: context.operationId, code, message };
}
function projectGroup(group: SessionGroup, ledger: OperationLedger, confirmed: ReadonlySet<string>, sessionId: string, outputs = false) {
    const operation = ledger.getSnapshot().find(record => (record.kind === 'send' || record.kind === 'command') && record.conversationId === sessionId
        && group.id === `round-${record.context.operationId}-user`);
    const parts: MessagePart[] = group.role === 'user' ? [{ id: 'body', kind: 'markdown', text: group.content ?? '' }]
        : projectNode(group.executionRoot);
    const input = group.role === 'user' ? group.callInput?.admitted?.parameters ?? getOperationCallInput(operation)?.values : undefined;
    if (input) parts.push({id: 'arguments', kind: 'json', value: input});
    for (const [index, file] of (group.files ?? []).entries()) parts.push({ id: `attachment-${index}`, kind: 'attachment',
        file: { id: file.path ?? file.name, name: file.name, mimeType: file.type } });
    if (outputs) parts.push(...messageOutputs(group));
    return { id: group.id, revision: 0, role: group.role, parts, timestamp: group.timestamp,
        state: messageState(group.executionRoot?.status),
        submissionId: operation?.context.operationId,
        acceptance: operation && !confirmed.has(operation.context.operationId) ? 'optimistic' as const : 'confirmed' as const };
}
function projectNode(node?: ExecutionNode): MessagePart[] {
    if (!node) return [];
    if (node.data.metaInfo?.flowInteraction || node.children?.some(child => child.data.metaInfo?.flowInteraction))
        return [...(node.children ?? []).flatMap(projectNode), flowNodeDocument(node)];
    const parts: MessagePart[] = [];
    if (node.executorType === 'tool') parts.push({ id: node.id, kind: 'tool', name: node.name,
        summary: node.data.toolCall?.name ?? node.name, detail: node.data.error ?? node.data.output,
        state: toolState(node.status) });
    else {
        if (node.data.thought) parts.push({ id: `${node.id}-thought`, kind: 'reasoning', text: node.data.thought });
        if (node.data.output) parts.push({ id: node.id, kind: 'markdown', text: node.data.output });
        if (node.data.error) parts.push({id: `${node.id}-error`, kind: 'markdown', text: node.data.error});
    }
    return [...parts, ...(node.children ?? []).flatMap(projectNode)];
}

function assertIndependentReceipt(receipt: IndependentCallReceipt, caller: string): void {
    if (!receipt || receipt.callerSessionId !== caller || !['accepted', 'unknown'].includes(receipt.status)
        || receipt.status === 'accepted' && (!receipt.executionSessionId || receipt.executionSessionId === caller))
        throw Object.assign(new Error('Independent call receipt scope mismatch'), {code: 'CALL_SUBMISSION_RECEIPT_MISMATCH'});
}

function logIndependentRead(error: unknown, operationId: string, started: number): void {
    const supplied = (error as {code?: unknown})?.code;
    independentLog.warn('call.receipt', {operationId: /^[\w:-]{1,256}$/.test(operationId) ? operationId : undefined,
        stage: 'independent-admission-read', result: 'failure', durationMs: Date.now() - started,
        code: typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied : 'CALL_RECEIPT_READ_FAILED'});
}
