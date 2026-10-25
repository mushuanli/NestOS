import type {ConversationControls, ConversationQueueEdit, ConversationSnapshot} from '@itookit/ui-common';
import {NativeInstructionQueuePanel} from '../components/NativeInstructionQueuePanel';
import type {ImageChatOptions} from './image-chat-view';

export interface NativeQueuePort {
    snapshot(): ConversationSnapshot | undefined;
    read(): Promise<ConversationSnapshot>;
    editInstructionQueue(edit: ConversationQueueEdit): Promise<ConversationSnapshot>;
}

export function createNativeQueuePort(controls: ConversationControls, snapshot: NativeQueuePort['snapshot'],
    execute: (action: () => Promise<ConversationSnapshot>) => Promise<ConversationSnapshot>): NativeQueuePort | undefined {
    if (!controls.enqueue || !controls.editInstructionQueue) return;
    return {snapshot, read: () => execute(() => controls.read()),
        editInstructionQueue: edit => execute(() => controls.editInstructionQueue!(edit))};
}

/** The host owns queue actions; the independent view owns editing and its lifecycle. */
export function nativeQueueToolbar(queue: NativeQueuePort | undefined, options: ImageChatOptions) {
    if (!queue) return {mount: options.mountToolbar, setActive(_value: boolean) {}};
    let active = true;
    const updates = new Set<() => void>();
    const mount: NonNullable<ImageChatOptions['mountToolbar']> = (root, context) => {
        const borrowed = options.mountToolbar?.(root, context);
        const element = document.createElement('section'); root.append(element);
        const panel = new NativeInstructionQueuePanel(element, queue, async () => {});
        const update = () => {
            const state = queue.snapshot(); if (state) panel.update(state);
            panel.setReadOnly(!active || !state?.canQueue);
        };
        updates.add(update); update();
        return {update: state => {borrowed?.update?.(state); update();},
            destroy: async () => {updates.delete(update); panel.destroy(); await borrowed?.destroy();}};
    };
    return {mount, setActive(value: boolean) {active = value; for (const update of updates) update();}};
}
