import {createImageChatView, type ImageChatOptions} from './image-chat-view';
import type {ImageEditingHost} from './image-editing';
import {prepareRemoteAttachments} from '../shell/remote-attachments';
import { type ChatMessage, type ConversationActions,
    type InteractionView, type OperationLedger, type OperationRecord, type CommandSubmission, type OperationContext, type OperationReceipt } from '@itookit/llm-ui';
import type { ConversationControls, ConversationSnapshot as NativeSnapshot } from '@itookit/ui-common';
import {NativeComposerCapabilities, type NativeCommandProvider} from './native-composer';
import {submitNativeCommand} from './native-command';
import {nativeControlReceipt} from './native-control';
import {createNativeQueuePort, nativeQueueToolbar} from './native-queue';
import {nativeCatalogNotice} from './native-catalog';
import { ChatProjection } from './projection';
import {nativeInteraction, nativeResponse} from '../native-interactions';
import {createModuleLogger} from '@itookit/common';
import {t} from '@itookit/common';
import {NativeCommandOutput} from '../components/history/NativeCommandOutput';
import {NativeResultRepair} from '../components/history/NativeResultRepair';
import type {ConversationCommandOutput} from '@itookit/ui-common';
import type {ExtensionRenderer, JsonValue} from '@itookit/llm-ui';

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
        source.publish({ title: state.title, selectors: capabilities.selectors(), error: nativeResultNotice(state) ?? nativeCatalogNotice(state),
            commands: state.supportsSlashCommands || options.commandProviders?.length ? catalog : undefined,
            operationReceipts: nativeReceipts(state, options.operations, options.conversationId),
            messages: state.messages.map(message => nativeMessage(message, options.operations, state, options.conversationId)),
            interactions: state.requests.map(request => interaction(request, requests)),
            loading: false, executionRef: state.observation?.activeTurnId ?? undefined, execution: state.observation?.execution === 'waiting-approval' ? 'waiting-input' : state.observation?.execution ?? 'unknown',
            connection: state.disconnected ? 'offline' : 'online', hasEarlier: state.hasEarlier ?? false,
            allowed: [...(nativeCanSubmit(state, options.controls) ? ['send' as const] : []), ...(state.canRespond ? ['respond' as const] : []),
                ...(state.canInterrupt && state.sessionId && state.observation?.activeTurnId && options.controls.reconcileControl ? ['cancel' as const] : []),
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
        && command.revision === input.target.expectedRevision && command.kind === input.kind && !command.disabled
        && (input.execution === undefined || input.execution === command.execution));
    const nativeCommand = async (input: CommandSubmission, context: OperationContext) => {
        const cached = findCommand(input), descriptor = cached && capabilities.resolve(cached.commandId);
        const independentQuery = descriptor?.execution === 'query' && native?.canQueryCommand && options.controls.queryCommand;
        try {if (!independentQuery) await capabilities.refreshCommands(native!);}
        catch {return reject(context, 'DIRECTORY_UNAVAILABLE', 'Native command directory unavailable');}
        if (!valid(context.viewId)) return reject(context, 'STALE_VIEW', 'Observation binding expired');
        publish(native!);
        const command = findCommand(input);
        if (!command) return reject(context, 'STALE_COMMAND', 'Command changed or is unavailable');
        const currentDescriptor = capabilities.resolve(command.commandId);
        if (!currentDescriptor) return reject(context, 'STALE_COMMAND', 'Native command definition unavailable');
        let selection: import('@itookit/ui-common').ConversationModelSelection | undefined;
        try {selection = command.kind === 'prompt' ? capabilities.selection(input.selection) : undefined;}
        catch (error) {return reject(context, 'INVALID_SELECTION', String(error));}
        const captured = generation;
        return submitNativeOperation(context, async () => {
            const state = currentDescriptor.execution !== 'query' && native?.canQueue && options.controls.enqueue
                ? await options.controls.enqueue(input.text, [], selection, context.operationId)
                : await submitNativeCommand(options.controls, currentDescriptor, input.arguments, input.text, selection, context.operationId);
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
        async cancel(executionRef, context) {
            if (!valid(context.viewId) || !options.controls.reconcileControl) return reject(context, 'CONTROL_UNAVAILABLE', 'Native control binding unavailable');
            const latest = options.controls.snapshot?.(); if (latest) publish(latest);
            const state = native;
            if (!state?.canInterrupt || !state.sessionId || state.observation?.activeTurnId !== executionRef)
                return reject(context, 'STALE_EXECUTION', 'Native execution changed or cannot be interrupted');
            const captured = generation;
            try {
                const result = await options.controls.interrupt({sessionId: state.sessionId, turnId: executionRef, operationId: context.operationId});
                publishResponse(result, captured); return nativeControlReceipt(result, context.operationId, executionRef);
            } catch (error) {
                const observed = options.controls.snapshot?.();
                if (observed) {
                    publishResponse(observed, captured);
                    const receipt = nativeControlReceipt(observed, context.operationId, executionRef);
                    if (receipt.status !== 'unknown') return receipt;
                }
                if ((error as {outcome?: string})?.outcome === 'not-committed') return reject(context, 'CONTROL_REJECTED', 'Native control was not submitted');
                throw error;
            }
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
            if (native?.resultError?.operationId === operationId) {
                const state = await options.controls.reconcile(operationId); publish(state);
                return {status: 'accepted', operationId, submissionRef: operationId};
            }
            const record = options.operations.getSnapshot().find(row => row.context.operationId === operationId);
            if (record?.kind === 'command' && record.input && typeof record.input === 'object' && 'execution' in record.input && record.input.execution === 'query') {
                if (record.conversationId !== options.conversationId) return {status: 'rejected', operationId, code: 'QUERY_SCOPE_CHANGED', message: 'Query belongs to another conversation'};
                if (!options.controls.reconcileQuery) return {status: 'unknown', operationId, message: 'Read-only query recovery unavailable'};
                const state = await options.controls.reconcileQuery(operationId); publish(state);
                return state.queryReceipts?.some(row => row.id === operationId) ? {status: 'accepted', operationId, submissionRef: operationId}
                    : {status: 'unknown', operationId, message: 'Query observation was not durably recorded'};
            }
            if (record?.kind === 'cancel' || native?.controls?.some(row => row.operationId === operationId)) {
                if (record && record.conversationId !== options.conversationId) return {status: 'rejected', operationId, code: 'CONTROL_SCOPE_CHANGED', message: 'Control belongs to another conversation'};
                if (!options.controls.reconcileControl) return {status: 'unknown', operationId, message: 'Native control recovery unavailable'};
                const state = await options.controls.reconcileControl(operationId); publish(state);
                return nativeControlReceipt(state, operationId, typeof record?.input === 'string' ? record.input : undefined);
            }
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
        resultError: () => native?.resultError,
        commandOutputs: {readCommandOutput: options.controls.readCommandOutput ? async (id: string, readOptions?: {offset?: number; limit?: number}) => {
            if (closed) throw Object.assign(new Error(), {code: 'COMMAND_OUTPUT_VIEW_CLOSED'});
            const page = await options.controls.readCommandOutput!(id, readOptions);
            if (closed) throw Object.assign(new Error(), {code: 'COMMAND_OUTPUT_VIEW_CLOSED'});
            return page;
        } : undefined, loadCommandOutput: options.controls.loadCommandOutput ? async (id: string, readOptions?: {maxBytes?: number}) => {
            if (closed) throw Object.assign(new Error(), {code: 'COMMAND_OUTPUT_VIEW_CLOSED'});
            const content = await options.controls.loadCommandOutput!(id, readOptions);
            if (closed) throw Object.assign(new Error(), {code: 'COMMAND_OUTPUT_VIEW_CLOSED'});
            return content;
        } : undefined},
        dispose() { if (closed) return; closed = true; lifetime.abort(); ++generation; capabilities.dispose(); releaseBinding([...(off ? [off] : []), offLedger, ...providerStops]); } };
}
export async function createNativeChatView(container: HTMLElement, binding: Awaited<ReturnType<typeof createNativeChatBinding>>,
    options: ImageChatOptions = {}) {
    const outputs = new Set<NativeCommandOutput>(), repairs = new Set<NativeResultRepair>();
    const queue = nativeQueueToolbar(binding.instructionQueue, options);
    const renderer: ExtensionRenderer = (root, part) => {
        const output = new NativeCommandOutput(binding.commandOutputs); root.append(output.element); outputs.add(output);
        output.update(part.data as unknown as ConversationCommandOutput);
        return {update: part => output.update(part.data as unknown as ConversationCommandOutput), destroy: () => {outputs.delete(output); output.destroy();}};
    };
    const view = await createImageChatView(container, {...options, source: binding.source, actions: binding.actions, operations: binding.operations,
        renderers: {...options.renderers, 'native-command-output': renderer},
        mountToolbar: nativeToolbar(binding, {...options, mountToolbar: queue.mount}, repairs)}, options.images ?? binding.images);
    const active = view.setActive.bind(view), destroy = view.destroy.bind(view);
    let closing: Promise<void> | undefined;
    view.setActive = value => {
        if (closing) return;
        queue.setActive(value); for (const output of outputs) output.setActive(value); for (const repair of repairs) repair.setActive(value); active(value);
    };
    view.destroy = () => closing ??= (async () => {queue.setActive(false); for (const output of outputs) output.setActive(false); await destroy();})();
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
    if (message.commandOutput) parts.push({id: `${message.id}-output`, kind: 'extension', type: 'native-command-output',
        data: JSON.parse(JSON.stringify(message.commandOutput)) as JsonValue});
    return { id: message.id, revision: 0, role: message.role, state: message.status === 'streaming' ? 'streaming' : 'complete',
        submissionId: record?.context.operationId, acceptance: message.id.startsWith('submitted:') ? 'optimistic' : 'confirmed',
        parts };
}

function nativeResultNotice(state: NativeSnapshot): {code: string; message: string} | undefined {
    return state.resultError ? {code: state.resultError.code, message: t('harness.resultPending', {code: state.resultError.code})} : undefined;
}

function nativeToolbar(binding: Awaited<ReturnType<typeof createNativeChatBinding>>, options: ImageChatOptions, repairs: Set<NativeResultRepair>): NonNullable<ImageChatOptions['mountToolbar']> {
    return (root, context) => {
        const host = options.mountToolbar?.(root, context);
        const repair = new NativeResultRepair(id => binding.actions.reconcile!(id)); repairs.add(repair); root.append(repair.element); repair.update(binding.resultError());
        return {update: current => {host?.update?.(current); repair.update(binding.resultError());},
            destroy: async () => {repairs.delete(repair); repair.destroy(); await host?.destroy();}};
    };
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

function nativeAdmissionReceipt(state: NativeSnapshot, context: OperationContext): OperationReceipt | undefined {
    if (state.queryReceipts?.some(row => row.id === context.operationId)) return {status: 'accepted', operationId: context.operationId, submissionRef: context.operationId};
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

function nativeSubmissionFailure(context: OperationContext, error: unknown, started: number): OperationReceipt {
    const failure = error as {outcome?: string; remoteCode?: string}, code = failure?.remoteCode;
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'NATIVE_REJECTED';
    try {log.warn('native.submit', {operationId: context.operationId, stage: 'dispatch', result: 'failure',
        code: safeCode, outcome: failure?.outcome === 'not-committed' ? 'not-committed' : 'unknown', durationMs: Date.now() - started});}
    catch { /* Preserve the native receipt classification when diagnostics fail. */ }
    if (failure?.outcome !== 'not-committed') throw error;
    return reject(context, safeCode, String(error));
}

function nativeReceipts(state: NativeSnapshot, operations: OperationLedger, conversationId: string): OperationReceipt[] {
    const admitted = new Map<string, {id: string; turnId?: string; commandId?: string}>(
        (state.instructionQueue?.submissions ?? state.instructionQueue?.acceptedIds.map(id => ({id})) ?? []).map(row => [row.id, row]));
    for (const query of state.queryReceipts ?? []) admitted.set(query.id, {id: query.id});
    if (state.submission?.status === 'accepted') admitted.set(state.submission.id, {id: state.submission.id, turnId: state.submission.turnId});
    return operations.getSnapshot().filter(record => record.conversationId === conversationId).flatMap(record => {
        if (record.kind === 'cancel') {
            const receipt = nativeControlReceipt(state, record.context.operationId, typeof record.input === 'string' ? record.input : undefined);
            return receipt.status === 'unknown' ? [] : [receipt];
        }
        if (!['send', 'command'].includes(record.kind) || !admitted.has(record.context.operationId)) return [];
        const submission = admitted.get(record.context.operationId)!;
        const user = submission.turnId && state.messages.find(message => message.role === 'user' && message.turnId === submission.turnId);
        return [{status: 'accepted' as const, operationId: record.context.operationId, submissionRef: submission.id,
            ...(user ? {observedUserMessageId: user.id} : {})}];
    });
}

function releaseBinding(stops: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const stop of stops) {try {stop();} catch (error) {errors.push(error);}}
    if (errors.length) throw new AggregateError(errors, 'Native binding cleanup failed');
}
