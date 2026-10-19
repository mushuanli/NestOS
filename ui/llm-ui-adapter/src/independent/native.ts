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
            commands: state.supportsSlashCommands || options.commandProviders?.length ? catalog : undefined, messages: state.messages.map(message => nativeMessage(message, options.operations)),
            interactions: state.requests.map(request => interaction(request, requests)),
            loading: false, execution: state.observation?.execution === 'waiting-approval' ? 'waiting-input' : state.observation?.execution ?? 'unknown',
            connection: state.disconnected ? 'offline' : 'online', hasEarlier: state.hasEarlier ?? false,
            allowed: [...(state.canSend && !state.pending ? ['send' as const] : []), ...(state.canRespond ? ['respond' as const] : []),
                ...(catalog.some(command => !command.disabled) ? ['command' as const] : [])] });
    };
    const loadCapabilities = async (state: NativeSnapshot, force = false) => {
        if (await capabilities.load(state, force) && !closed && native) publish(native);
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
            const state = await submitNativeCommand(options.controls, {name: command.commandId, kind: command.kind}, input.arguments, input.text, selection);
            publishResponse(state, captured); return state;
        }, false);
    };
    const actions: ConversationActions = {
        async send(input, context) {
            if (!valid(context.viewId)) return { status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: 'Observation binding expired' };
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
                const state = selection ? await options.controls.send(input.text, attachments, selection)
                    : attachments.length ? await options.controls.send(input.text, attachments) : await options.controls.send(input.text);
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
        dispose() { if (closed) return; closed = true; lifetime.abort(); ++generation; capabilities.dispose(); releaseBinding([...(off ? [off] : []), offLedger, ...providerStops]); } };
}
export function createNativeChatView(container: HTMLElement, binding: Awaited<ReturnType<typeof createNativeChatBinding>>,
    options: ImageChatOptions = {}) {
    return createImageChatView(container, {...options, source: binding.source, actions: binding.actions, operations: binding.operations}, options.images ?? binding.images);
}
function nativeMessage(message: NativeSnapshot['messages'][number], operations: OperationLedger): ChatMessage {
    const record = operations.getSnapshot().find(item => (item.kind === 'send' || item.kind === 'command') && item.submissionRef && item.submissionRef === message.turnId);
    return { id: message.id, revision: 0, role: message.role, state: message.status === 'streaming' ? 'streaming' : 'complete',
        submissionId: record?.context.operationId, acceptance: message.id.startsWith('submitted:') ? 'optimistic' : 'confirmed',
        parts: message.role === 'tool' ? [{ id: message.id, kind: 'tool', name: message.name ?? '',
            summary: message.commandPreview ?? message.operation ?? '', state: 'succeeded' }]
            : (message.contentParts ?? [message.text]).map((text, index) => ({ id: `${message.id}-${index}`, kind: 'markdown', text })) };
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
    let state: NativeSnapshot;
    try {state = await action();}
    catch (error) {
        if ((error as {outcome?: string})?.outcome !== 'not-committed') throw error;
        return reject(context, 'NATIVE_REJECTED', String(error));
    }
    return state.pending || expectsTurn && !state.submittedTurnId
        ? {status: 'unknown', operationId: context.operationId, message: 'Awaiting native receipt'}
        : {status: 'accepted', operationId: context.operationId, ...(state.submittedTurnId ? {submissionRef: state.submittedTurnId} : {})};
}

function releaseBinding(stops: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const stop of stops) {try {stop();} catch (error) {errors.push(error);}}
    if (errors.length) throw new AggregateError(errors, 'Native binding cleanup failed');
}
