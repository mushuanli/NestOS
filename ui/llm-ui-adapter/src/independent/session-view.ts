import {CHAT_SLOT_CLASSES} from '@itookit/llm-ui';
import {disposeEditorResources} from '../shell/editor-disposal';
import {createChatView, type ChatView} from '@itookit/llm-ui';
import type {createSessionChatBinding} from './session';
import {SessionContextPicker} from './session-context';
import {sessionQueueToolbar} from './session-queue';
import {flowNodeDocumentPart, flowNodeDocumentRenderer} from './flow-node-document';
import {independentCallPart} from './session-calls';
import {messageOutputsPart} from './message-outputs';
import {prepareImageChatOptions, type ImageChatOptions} from './image-chat-view';

type Binding = ReturnType<typeof createSessionChatBinding>;
export type SessionChatView = ChatView;
export function replaceSessionChatBinding(view: ChatView, binding: Binding, options: ImageChatOptions = {}): Promise<void> {
    return view.replaceBinding(prepare(binding, options), {draft: options.initialDraft});
}
/** Transfer a prepared Session into a host-owned view without replacing its input. */
export async function adoptSessionChatView(view: ChatView, binding: Binding, options: ImageChatOptions = {}): Promise<SessionChatView> {
    await view.replaceBinding(prepare(binding, options)); return view;
}
function prepare(binding: Binding, options: ImageChatOptions): Parameters<typeof createChatView>[1] {
    if (options.renderers?.[messageOutputsPart] || options.renderers?.[independentCallPart])
        throw new Error('Execution output and independent call renderers are reserved by the Session adapter');
    const queue = sessionQueueToolbar(binding.instructionQueue, options), calls = binding.mountCalls();
    const mounted = {...options, mountToolbar: queue.mount}; let picker: SessionContextPicker | undefined;
    const mountToolbar: ImageChatOptions['mountToolbar'] = calls || binding.contextSelection ? (host, context) => {
        const custom = document.createElement('div'); custom.className = CHAT_SLOT_CLASSES.toolbar; host.append(custom);
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
    return {...images,
        setActive: active => {binding.setActive(active); queue.setActive(active); picker?.setActive(active); options.setActive?.(active);},
        release: () => disposeEditorResources([() => binding.releaseCalls(calls), () => images.release?.()])};
}
/** Session-specific hooks are replaceable; the underlying ChatView and composer stay mounted. */
export async function createRetainedSessionChatView(container: HTMLElement, binding: Binding, options: ImageChatOptions = {}): Promise<SessionChatView> {
    const initial = prepare(binding, options);
    return createChatView(container, initial);
}
