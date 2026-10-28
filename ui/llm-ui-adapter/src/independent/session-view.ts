import {createChatView, type ChatView} from '@itookit/llm-ui';
import type {createSessionChatBinding} from './session';
import {SessionContextPicker} from './session-context';
import {sessionQueueToolbar} from './session-queue';
import {flowNodeDocumentPart, flowNodeDocumentRenderer} from './flow-node-document';
import {independentCallPart} from './session-calls';
import {messageOutputsPart} from './message-outputs';
import {prepareImageChatOptions, type ImageChatOptions} from './image-chat-view';
import {retainViewBindings, type ViewBinding} from './retained-view';

type Binding = ReturnType<typeof createSessionChatBinding>;
export interface SessionChatView extends ChatView {
    replaceSessionBinding(binding: Binding, options?: ImageChatOptions): Promise<void>;
}
const retainedViews = new WeakMap<ChatView, ReturnType<typeof retainViewBindings>>();
function attach(view: ChatView, initial: ViewBinding): SessionChatView {
    const retained = retainedViews.get(view) ?? retainViewBindings(view, initial); retainedViews.set(view, retained);
    return Object.assign(view, {replaceSessionBinding: (next: Binding, nextOptions: ImageChatOptions = {}) =>
        retained.replace(prepare(next, nextOptions), nextOptions.initialDraft)});
}
/** Transfer a prepared Session into a host-owned view without replacing its input. */
export async function adoptSessionChatView(view: ChatView, binding: Binding, options: ImageChatOptions = {}): Promise<SessionChatView> {
    const prepared = prepare(binding, options), result = attach(view, {options: prepared.options});
    await retainedViews.get(view)!.replace(prepared); return result;
}
function prepare(binding: Binding, options: ImageChatOptions): ViewBinding & {options: Parameters<typeof createChatView>[1]} {
    if (options.renderers?.[messageOutputsPart] || options.renderers?.[independentCallPart])
        throw new Error('Execution output and independent call renderers are reserved by the Session adapter');
    const queue = sessionQueueToolbar(binding.instructionQueue, options), calls = binding.mountCalls();
    const mounted = {...options, mountToolbar: queue.mount}; let picker: SessionContextPicker | undefined;
    const mountToolbar: ImageChatOptions['mountToolbar'] = calls || binding.contextSelection ? (host, context) => {
        const custom = document.createElement('div'); custom.className = 'llm-chat__host-toolbar'; host.append(custom);
        const borrowed = mounted.mountToolbar?.(custom, context);
        if (calls) host.append(calls.notices);
        if (binding.contextSelection) picker = new SessionContextPicker(host, context, () => binding.contextScope(), query => binding.readContextOptions(query));
        return {update: next => {borrowed?.update?.(next); picker?.update(next);},
            destroy: async () => {picker?.destroy(); picker = undefined; try {await borrowed?.destroy();} finally {custom.remove(); calls?.notices.remove();}}};
    } : mounted.mountToolbar;
    const images = prepareImageChatOptions({...options, mountToolbar,
        onDraftChange: draft => {picker?.updateDraft(draft); options.onDraftChange?.(draft);},
        renderers: {...options.renderers, [flowNodeDocumentPart]: flowNodeDocumentRenderer,
            ...(calls ? {[independentCallPart]: calls.renderer} : {}), ...(binding.outputsRenderer ? {[messageOutputsPart]: binding.outputsRenderer} : {})},
        source: binding.source, actions: binding.actions, operations: binding.operations}, options.images ?? binding.images);
    return {options: images.options,
        setActive: active => {binding.setActive(active); queue.setActive(active); picker?.setActive(active);},
        release: async () => {try {binding.releaseCalls(calls);} finally {await images.release();}}};
}
/** Session-specific hooks are replaceable; the underlying ChatView and composer stay mounted. */
export async function createRetainedSessionChatView(container: HTMLElement, binding: Binding, options: ImageChatOptions = {}): Promise<SessionChatView> {
    const initial = prepare(binding, options);
    try {
        return attach(await createChatView(container, initial.options), initial);
    } catch (error) {await initial.release?.(); throw error;}
}
