import { contextToolDefinitions, validateContextCompaction, type ChatMessage, type ContextCursor, type ContextCompactionPolicy, type PreparedContext, type WorkingNotes } from '@itookit/llm-context';
import type { Decision, DurableTaskProgram, EffectRequest, JsonValue, KernelAction, TaskInputEvent } from '@itookit/durable-kernel';
import type { DurableAgentInput } from './types';

interface ContextProgramState<S> {
    inner: S;
    cursor?: ContextCursor;
    pending?: EffectRequest;
    preparing?: string;
    policy?: ContextCompactionPolicy;
    notes?: WorkingNotes;
    completion?: { next: Decision<S>['next']; actions: KernelAction[] };
}

/** Versioned wrapper keeps legacy reducers and their approval identities recoverable. */
export class ContextTaskProgram<S, O> implements DurableTaskProgram<ContextProgramState<S>, DurableAgentInput, O> {
    readonly manifest: { kind: string; version: string };
    constructor(private readonly inner: DurableTaskProgram<S, DurableAgentInput, O>) {
        this.manifest = { kind: inner.manifest.kind, version: '2' };
    }
    async init(input: DurableAgentInput): Promise<Decision<ContextProgramState<S>, O>> {
        validateContextCompaction(input.contextCompaction);
        const source = structuredClone(input);
        delete source.contextCompaction;
        return this.wrap(await this.inner.init(source), undefined, input.contextCompaction);
    }
    async reduce(state: Readonly<ContextProgramState<S>>, event: TaskInputEvent): Promise<Decision<ContextProgramState<S>, O>> {
        if (state.preparing) return acceptPrepared(state, event);
        const checkpoint = checkpointFromEvent(state.inner, event);
        const inner = this.manifest.kind === 'llm.agent' ? withContextToolGrants(state.inner) : state.inner;
        return this.wrap(await this.inner.reduce(inner, event), state.cursor, state.policy, checkpoint ?? state.notes);
    }
    private wrap(decision: Decision<S, O>, cursor?: ContextCursor, policy?: ContextCompactionPolicy, notes?: WorkingNotes): Decision<ContextProgramState<S>, O> {
        const state: ContextProgramState<S> = { inner: decision.state, ...(cursor ? { cursor } : {}), ...(policy ? { policy } : {}), ...(notes ? { notes } : {}) };
        const actions = (decision.actions ?? []).map(action => upgradeTool(action, policy));
        const index = actions.findIndex(action => action.type === 'effect' && action.effect.kind === 'llm.chat');
        if (index < 0) return recordCompletion(decision, state, actions);
        const action = actions[index] as Extract<KernelAction, { type: 'effect' }>;
        if (this.manifest.kind === 'llm.agent') addContextTools(action.effect, decision.state);
        tagSkillPolicies(action.effect, decision.state);
        const effect = prepareEffect(action.effect, cursor, policy, notes);
        state.pending = { ...action.effect, request: withoutMessages(action.effect.request) };
        state.preparing = effect.id;
        clearWorkingMessages(state.inner);
        actions[index] = { type: 'effect', effect };
        return { state, actions, next: { type: 'wait', on: { type: 'effect', id: effect.id } } };
    }
}

/** Only the v2 host wrapper can grant its built-in context tools. */
function withContextToolGrants<S>(state: S): S {
    const inner = state as { input: DurableAgentInput; capabilities?: { toolHandleId?: string } };
    if (!inner.capabilities?.toolHandleId || !inner.input.allowedToolIds) return state;
    const names = contextToolDefinitions().map(tool => tool.function!.name);
    return { ...state, input: { ...inner.input, allowedToolIds: [...new Set([...inner.input.allowedToolIds, ...names])] } };
}

function prepareEffect(effect: EffectRequest, cursor?: ContextCursor, policy?: ContextCompactionPolicy, notes?: WorkingNotes): EffectRequest {
    const request = effect.request as { request: { messages: ChatMessage[] }; resourceHandleId: string; connectionId: string };
    const { messages, ...parameters } = request.request;
    return { ...effect, kind: 'context.prepare', version: '1', id: `context-${effect.id}`,
        idempotencyKey: `${effect.idempotencyKey}:context`, request: {
            resourceHandleId: request.resourceHandleId, connectionId: request.connectionId,
            messages, request: parameters, ...(cursor ? { previous: cursor } : {}),
            ...(policy ? { policy } : {}),
            ...(notes ? { notes } : {}),
        } };
}

function withoutMessages(value: unknown): unknown {
    const request = value as { resourceHandleId: string; connectionId: string };
    return { resourceHandleId: request.resourceHandleId, connectionId: request.connectionId };
}

function clearWorkingMessages(state: unknown): void {
    const inner = state as { messages?: ChatMessage[]; input: { messages: ChatMessage[] } };
    if (inner.messages) inner.messages = [];
    inner.input.messages = [];
}

function upgradeTool(action: KernelAction, policy?: ContextCompactionPolicy): KernelAction {
    return action.type === 'effect' && action.effect.kind === 'tool.call'
        ? { ...action, effect: { ...action.effect, version: '2', request: { ...action.effect.request as object,
            ...(policy?.maxToolOutputBytes ? { maxOutputBytes: policy.maxToolOutputBytes } : {}) } } } : action;
}

function acceptPrepared<S, O>(state: Readonly<ContextProgramState<S>>, event: TaskInputEvent): Decision<ContextProgramState<S>, O> {
    if (event.type === 'effect-failed' && event.effectId === state.preparing) return { state, next: { type: 'fail', error: event.error } };
    if (event.type !== 'effect-completed' || event.effectId !== state.preparing || (!state.pending && !state.completion)) {
        throw new Error('Unexpected context preparation result');
    }
    const result = event.result as PreparedContext;
    const actions: KernelAction[] = result.writes.map(write => ({ type: 'set-shared', key: write.key,
        value: JSON.parse(JSON.stringify(write.value)) as JsonValue, expectedVersion: write.expectedVersion }));
    if (state.completion) return { state: { inner: state.inner, cursor: result.cursor },
        actions: [...actions, ...state.completion.actions], next: state.completion.next as Decision<S, O>['next'] };
    const effect = { ...state.pending!, version: '2', request: { ...state.pending!.request as object, cursor: result.cursor } };
    actions.push({ type: 'effect', effect }, { type: 'emit', eventType: 'context.prepared', payload: result.explanation });
    return { state: { inner: state.inner, cursor: result.cursor, ...(state.policy ? { policy: state.policy } : {}) }, actions,
        next: { type: 'wait', on: { type: 'effect', id: effect.id } } };
}

function checkpointFromEvent(state: unknown, event: TaskInputEvent): WorkingNotes | undefined {
    const inner = state as { phase: string; pendingCalls: Array<{ id: string; function?: { name?: string } }>; callIndex: number; exchanges: number };
    const call = inner.pendingCalls?.[inner.callIndex];
    if (inner.phase !== 'tool' || call?.function?.name !== 'context_checkpoint' || event.type !== 'effect-completed'
        || event.effectId !== `tool-${inner.exchanges}-${call.id}`) return undefined;
    return (event.result as { checkpoint?: WorkingNotes })?.checkpoint;
}

function addContextTools(effect: EffectRequest, state: unknown): void {
    if (!(state as { capabilities?: { toolHandleId?: string } }).capabilities?.toolHandleId) return;
    const request = effect.request as { request: { tools?: import('@itookit/llm-context').ToolDefinition[]; toolChoice?: string } };
    const definitions = contextToolDefinitions();
    const names = new Set(definitions.map(tool => tool.function?.name));
    request.request.tools = [...(request.request.tools ?? []).filter(tool => !names.has(tool.function?.name)), ...definitions];
    request.request.toolChoice = 'auto';
}

function tagSkillPolicies(effect: EffectRequest, state: unknown): void {
    const skills = (state as { skillContexts?: Array<{ compactInstructions: string }> }).skillContexts ?? [];
    const count = skills.filter(skill => skill.compactInstructions.trim()).length;
    const request = effect.request as { request: { messages: ChatMessage[] } };
    request.request.messages = request.request.messages.map((message, index) => index < count
        ? { ...message, tags: [...(message.tags ?? []), 'context-skill-policy'] } : message);
}

function recordCompletion<S, O>(decision: Decision<S, O>, state: ContextProgramState<S>, actions: KernelAction[]): Decision<ContextProgramState<S>, O> {
    if (decision.next.type !== 'complete' || !state.cursor) return { ...decision, state, actions };
    const inner = state.inner as { input: DurableAgentInput; capabilities?: { llmHandleId?: string }; messages?: ChatMessage[] };
    const output = decision.next.output as { message?: ChatMessage };
    const messages = inner.messages?.length ? inner.messages : output?.message ? [output.message] : [];
    if (!messages.length || !inner.capabilities?.llmHandleId) return { ...decision, state, actions };
    const id = `context-final-${state.cursor.revision}`;
    state.preparing = id;
    state.completion = { next: decision.next, actions };
    const request = { resourceHandleId: inner.capabilities.llmHandleId, connectionId: inner.input.connectionId,
        previous: state.cursor, messages, request: {}, archiveOnly: true };
    clearWorkingMessages(state.inner);
    return { state, actions: [{ type: 'effect', effect: { id, kind: 'context.prepare', version: '1',
        request, idempotencyKey: id, grants: [{ handleId: inner.capabilities.llmHandleId, right: 'execute' }] } }],
        next: { type: 'wait', on: { type: 'effect', id } } };
}
