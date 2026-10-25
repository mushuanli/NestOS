import {createNativeQueuePort, nativeQueueToolbar} from './native-queue';
import type {OperationRecord} from '@itookit/llm-ui';
import {createModuleLogger} from '@itookit/common';
import {createImageChatView, type ImageChatOptions} from './image-chat-view';
import type {ImageEditingHost} from './image-editing';
import {prepareRemoteAttachments} from '../shell/remote-attachments';
import { type ChatMessage, type ConversationActions,
    type InteractionView, type OperationLedger, type CommandSubmission, type OperationContext, type OperationReceipt } from '@itookit/llm-ui';
import type { ConversationControls, ConversationSnapshot as NativeSnapshot } from '@itookit/ui-common';
import {NativeComposerCapabilities, type NativeCommandProvider} from './native-composer';
import {submitNativeCommand} from './native-command';
import { ChatProjection } from './projection';
import {nativeInteraction, nativeResponse} from '../native-interactions';

const log = createModuleLogger('native-submission');

export interface NativeChatBindingOptions {
    readonly images?: ImageEditingHost;
    readonly conversationId: string;
    readonly commandProviders?: readonly NativeCommandProvider[];
    readonly controls: ConversationControls;
    readonly operations: OperationLedger;
    /** Hosts reconcile this stable ID through the native or contributed command owner. */
    readonly reconcile: NonNullable<ConversationActions['reconcile']>;
    readonly onError?: (error: unknown) => void;
}
/** Native transport/recovery stays in controls; this adapter only projects presentation. */
export async function createNativeChatBinding(options: NativeChatBindingOptions) {
    const source = new ChatProjection(options.conversationId, options.onError);
    const lifetime = new AbortController();
    let closed = false, generation = 0, native: NativeSnapshot | undefined;
    const capabilities = new NativeComposerCapabilities(options.controls, options.onError);
    const contributions = (state: NativeSnapshot) => options.commandProviders?.map(provider => ({source: provider.source, commands: provider.commands(state)})) ?? [];
    const commands = (state: NativeSnapshot) => capabilities.compose(state, contributions(state));
    const requests = new Map<string, { encoded: string; revision: number }>();
    const publish = (state: NativeSnapshot) => {
        if (closed) return;
        native = state;
        const catalog = commands(state);
        source.publish({ title: state.title, selectors: capabilities.selectors(),
            commands: state.supportsSlashCommands || options.commandProviders?.length ? catalog : undefined, operationReceipts: nativeReceipts(state, options.operations, options.conversationId),
            messages: state.messages.map(message => nativeMessage(message, options.operations, state, options.conversationId)),
            interactions: state.requests.map(request => interaction(request, requests)),
            loading: false, execution: state.observation?.execution === 'waiting-approval' ? 'waiting-input' : state.observation?.execution ?? 'unknown',
            connection: state.disconnected ? 'offline' : 'online', hasEarlier: state.hasEarlier ?? false,
            allowed: [...(nativeCanSubmit(state, options.controls) ? ['send' as const] : []), ...(state.canRespond ? ['respond' as const] : []),
                ...(catalog.some(command => !command.disabled) ? ['command' as const] : [])] });
    };
    const loadCapabilities = async (state: NativeSnapshot, force = false) => {
        if (await capabilities.load(state, force) && !closed && native) publish(options.controls.snapshot?.() ?? native);
    };
    const refresh = async () => {
        const captured = ++generation, state = await options.controls.read();
        if (captured === generation) {publish(state); await loadCapabilities(state, true);}
    };
    const publishResponse = (state: NativeSnapshot, captured: number) => {
        if (captured !== generation) return;
        ++generation; publish(state);
    };
    const off = options.controls.subscribe?.(() => {
        ++generation;
        const state = options.controls.snapshot?.();
        if (state) {publish(state); void loadCapabilities(state).catch(error => options.onError?.(error));} else void refresh().catch(error => options.onError?.(error));
    });
    const providerStops = options.commandProviders?.flatMap(provider => provider.subscribe ? [provider.subscribe(() => {if (native) publish(native);})] : []) ?? [];
    const offLedger = options.operations.subscribe(() => { if (native) publish(native); });
    try { await refresh(); } catch (error) { closed = true; capabilities.dispose();
        try {releaseBinding([...(off ? [off] : []), offLedger, ...providerStops]);}
        catch (cleanup) {throw new AggregateError([error, cleanup], 'Native binding initialization failed');}
        throw error; }
    const valid = (viewId: string) => !closed && viewId === source.getSnapshot().viewId;
    const findCommand = (input: CommandSubmission) => commands(native!).find(command => command.id === input.target.id
        && command.revision === input.target.expectedRevision && command.kind === input.kind && !command.disabled);
    const nativeCommand = async (input: CommandSubmission, context: OperationContext) => {
        try {await capabilities.refreshCommands(native!);}
        catch {return reject(context, 'DIRECTORY_UNAVAILABLE', 'Native command directory unavailable');}
        if (!valid(context.viewId)) return reject(context, 'STALE_VIEW', 'Observation binding expired');
        publish(native!);
        const command = findCommand(input);
        if (!command) return reject(context, 'STALE_COMMAND', 'Command changed or is unavailable');
        let selection: import('@itookit/ui-common').ConversationModelSelection | undefined;
        try {selection = command.kind === 'prompt' ? capabilities.selection(input.selection) : undefined;}
        catch (error) {return reject(context, 'INVALID_SELECTION', String(error));}
        const captured = generation;
        return submitNativeOperation(context, async () => {
            const state = native?.canQueue && options.controls.enqueue
                ? await options.controls.enqueue(input.text, [], selection, context.operationId)
                : await submitNativeCommand(options.controls, {name: command.commandId, kind: command.kind}, input.arguments, input.text, selection, context.operationId);
            publishResponse(state, captured); return state;
        }, false);
    };
    const actions: ConversationActions = {
        async send(input, context) {
            if (!valid(context.viewId)) return { status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: 'Observation binding expired' };
            if (input.input) return reject(context, 'UNSUPPORTED_INPUT', 'Native message input has no declared structured argument binding');
            let attachments: NonNullable<Parameters<ConversationControls['send']>[1]> = [];
            if (input.attachments.length) {
                if (!options.images) return reject(context, 'ATTACHMENT_MAPPING_REQUIRED', 'Native attachments require host conversion');
                try {
                    const files: File[] = [];
                    for (const ref of input.attachments) files.push(new File([await options.images.read(ref, {signal: lifetime.signal})], ref.name, {type: ref.mimeType}));
                    attachments = await prepareRemoteAttachments(files, native?.attachments ?? []);
                } catch (error) {return reject(context, 'INVALID_ATTACHMENT', String(error));}
                if (!valid(context.viewId)) return reject(context, 'STALE_VIEW', 'Observation binding expired');
            }
            let selection: import('@itookit/ui-common').ConversationModelSelection | undefined;
            try {selection = capabilities.selection(input.selection);}
            catch (error) {return {status: 'rejected', operationId: context.operationId, code: 'INVALID_SELECTION', message: String(error)};}
            const captured = generation;
            return submitNativeOperation(context, async () => {
                const state = native?.canQueue && options.controls.enqueue
                    ? await options.controls.enqueue(input.text, attachments, selection, context.operationId)
                    : await options.controls.send(input.text, attachments, selection, context.operationId);
                publishResponse(state, captured); return state;
            }, true);
        },
        async command(input, context) {
            if (!valid(context.viewId)) return reject(context, 'STALE_VIEW', 'Observation binding expired');
            const command = findCommand(input);
            if (!command) return reject(context, 'STALE_COMMAND', 'Command changed or is unavailable');
            if (command.source.id === 'harness') return nativeCommand(input, context);
            const provider = options.commandProviders?.find(provider => provider.source.id === command.source.id);
            return provider ? provider.execute({...input, target: {...input.target, id: command.commandId}}, context)
                : reject(context, 'STALE_COMMAND', 'Command provider unavailable');
        },
        async respond(request, context) {
            if (!valid(context.viewId)) return { status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: 'Observation binding expired' };
            const latest = options.controls.snapshot?.();
            if (latest) publish(latest);
            const target = source.getSnapshot().interactions.find(item => item.id === request.id && item.revision === request.revision && item.state === 'pending');
            if (!target) return { status: 'rejected', operationId: context.operationId, code: 'STALE_REQUEST', message: 'Interaction changed or expired' };
            if (!native?.canRespond) return reject(context, 'INTERACTION_UNAVAILABLE', 'Interaction control unavailable');
            if (target.kind === 'unsupported' || target.responding) return reject(context, 'UNSUPPORTED_REQUEST', 'Interaction cannot be answered');
            const response = nativeResponse(request.response);
            const original = native!.requests.find(item => nativeInteraction(item).id === request.id)!;
            const captured = generation, state = await options.controls.respond(original.id, response);
            publishResponse(state, captured);
            return state.requests.some(item => item.id === original.id && item.responding)
                ? {status: 'unknown', operationId: context.operationId, message: 'Response receipt pending'} : { status: 'accepted', operationId: context.operationId };
        },
        async reconcile(operationId) {
            const receipt = await options.reconcile(operationId);
            await refresh(); return receipt;
        },
        loadEarlier: options.controls.loadEarlier ? async ({ signal }) => {
            const state = await options.controls.loadEarlier!();
            if (!signal.aborted && !closed) {
                const latest = options.controls.snapshot?.() ?? native ?? state;
                const ids = new Set(latest.messages.map(message => message.id));
                ++generation; publish({ ...latest, hasEarlier: state.hasEarlier,
                    messages: [...state.messages.filter(message => !ids.has(message.id)), ...latest.messages] });
            }
        } : undefined,
    };
    return { images: options.images, source: Object.assign(source, { refresh }), actions, operations: options.operations,
        instructionQueue: createNativeQueuePort(options.controls, () => native, async action => {
            if (closed) throw Object.assign(new Error('Native queue binding closed'), {code: 'QUEUE_VIEW_CLOSED'});
            const captured = generation, state = await action();
            if (closed) throw Object.assign(new Error('Native queue binding closed'), {code: 'QUEUE_VIEW_CLOSED'});
            publishResponse(state, captured); return state;
        }),
        dispose() { if (closed) return; closed = true; lifetime.abort(); ++generation; capabilities.dispose(); releaseBinding([...(off ? [off] : []), offLedger, ...providerStops]); } };
}
export async function createNativeChatView(container: HTMLElement, binding: Awaited<ReturnType<typeof createNativeChatBinding>>,
    options: ImageChatOptions = {}) {
    const queue = nativeQueueToolbar(binding.instructionQueue, options);
    const view = await createImageChatView(container, {...options, source: binding.source, actions: binding.actions,
        operations: binding.operations, mountToolbar: queue.mount}, options.images ?? binding.images);
    const active = view.setActive.bind(view), destroy = view.destroy.bind(view);
    let closing: Promise<void> | undefined;
    view.setActive = value => {if (closing) return; queue.setActive(value); active(value);};
    view.destroy = () => closing ??= (async () => {queue.setActive(false); await destroy();})();
    return view;
}
function nativeMessage(message: NativeSnapshot['messages'][number], operations: OperationLedger, state: NativeSnapshot, conversationId: string): ChatMessage {
    const submission = state.instructionQueue?.submissions?.find(item => item.turnId && item.turnId === message.turnId);
    const record = operations.getSnapshot().find(item => {
        if (item.conversationId !== conversationId || !nativeUserOperation(item)) return false;
        return item.context.operationId === submission?.id || !!item.submissionRef && item.submissionRef === message.turnId
            || item.observedUserMessageId === message.id;
    });
    const parts: ChatMessage['parts'][number][] = message.role === 'tool' ? [{ id: message.id, kind: 'tool', name: message.name ?? '',
        summary: message.commandPreview ?? message.operation ?? '', state: 'succeeded' }]
        : (message.contentParts ?? [message.text]).map((text, index) => ({ id: `${message.id}-${index}`, kind: 'markdown', text }));
    return { id: message.id, revision: 0, role: message.role, state: message.status === 'streaming' ? 'streaming' : 'complete',
        submissionId: record?.context.operationId, acceptance: message.id.startsWith('submitted:') ? 'optimistic' : 'confirmed',
        parts };
}

function interaction(request: NativeSnapshot['requests'][number], versions: Map<string, { encoded: string; revision: number }>): InteractionView {
    const id = nativeInteraction(request).id, encoded = JSON.stringify(request), previous = versions.get(id);
    const revision = previous?.encoded === encoded ? previous.revision : (previous?.revision ?? -1) + 1;
    versions.set(id, { encoded, revision });
    return nativeInteraction(request, revision);
}

function reject(context: OperationContext, code: string, message: string) {
    return {status: 'rejected' as const, operationId: context.operationId, code, message};
}

async function submitNativeOperation(context: OperationContext, action: () => Promise<NativeSnapshot>, expectsTurn: boolean): Promise<OperationReceipt> {
    let state: NativeSnapshot; const started = Date.now();
    try {state = await action();}
    catch (error) {return nativeSubmissionFailure(context, error, started);}
    const receipt = nativeAdmissionReceipt(state, context);
    if (receipt) return receipt;
    return state.pending || expectsTurn && !state.submittedTurnId
        ? {status: 'unknown', operationId: context.operationId, message: 'Awaiting native receipt'}
        : {status: 'accepted', operationId: context.operationId, ...(state.submittedTurnId ? {submissionRef: state.submittedTurnId} : {})};
}

function releaseBinding(stops: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const stop of stops) {try {stop();} catch (error) {errors.push(error);}}
    if (errors.length) throw new AggregateError(errors, 'Native binding cleanup failed');
}

function nativeSubmissionFailure(context: OperationContext, error: unknown, started: number): OperationReceipt {
    const failure = error as {outcome?: string; remoteCode?: string}, code = failure?.remoteCode;
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'NATIVE_REJECTED';
    try {log.warn('native.submit', {operationId: context.operationId, stage: 'dispatch', result: 'failure',
        code: safeCode, outcome: failure?.outcome === 'not-committed' ? 'not-committed' : 'unknown', durationMs: Date.now() - started});}
    catch { /* Preserve the native receipt classification when diagnostics fail. */ }
    if (failure?.outcome !== 'not-committed') throw error;
    return reject(context, safeCode, String(error));
}

function nativeAdmissionReceipt(state: NativeSnapshot, context: OperationContext): OperationReceipt | undefined {
    const receipt = state.submission;
    if (receipt?.id === context.operationId) {
        if (receipt.status === 'accepted') return {status: 'accepted', operationId: context.operationId, submissionRef: receipt.turnId ?? receipt.id};
        if (receipt.status === 'rejected') return reject(context, receipt.code ?? 'NATIVE_REJECTED', 'Native submission rejected');
    }
    if (state.instructionQueue?.acceptedIds.includes(context.operationId)) return {status: 'accepted', operationId: context.operationId, submissionRef: context.operationId};
}

function nativeCanSubmit(state: NativeSnapshot, controls: ConversationControls): boolean {
    return !!(state.canQueue && controls.enqueue || state.canSend && !state.pending);
}

function nativeUserOperation(record: OperationRecord): boolean {
    return record.kind === 'send' || record.kind === 'command' && !!record.input && typeof record.input === 'object'
        && 'kind' in record.input && record.input.kind === 'prompt';
}

function nativeReceipts(state: NativeSnapshot, operations: OperationLedger, conversationId: string): OperationReceipt[] {
    const admitted = new Map<string, {id: string; turnId?: string; commandId?: string}>(
        (state.instructionQueue?.submissions ?? state.instructionQueue?.acceptedIds.map(id => ({id})) ?? []).map(row => [row.id, row]));
    if (state.submission?.status === 'accepted') admitted.set(state.submission.id, {id: state.submission.id, turnId: state.submission.turnId});
    return operations.getSnapshot().filter(record => record.conversationId === conversationId).flatMap(record => {
        if (!['send', 'command'].includes(record.kind) || !admitted.has(record.context.operationId)) return [];
        const submission = admitted.get(record.context.operationId)!;
        const user = submission.turnId && state.messages.find(message => message.role === 'user' && message.turnId === submission.turnId);
        return [{status: 'accepted' as const, operationId: record.context.operationId, submissionRef: submission.id,
            ...(user ? {observedUserMessageId: user.id} : {})}];
    });
}

