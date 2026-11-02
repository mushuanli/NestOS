import type {ConversationControls, ConversationQueueEdit, ConversationSnapshot} from '../contracts';

import {NativeInstructionQueuePanel} from '../components/NativeInstructionQueuePanel';
import type {ImageChatOptions} from './image-chat-view';
import {createModuleLogger, randomUUID, t} from '@itookit/common';

const log = createModuleLogger('native-instruction-queue');

export interface NativeQueuePort {
    snapshot(): ConversationSnapshot | undefined;
    read(): Promise<ConversationSnapshot>;
    editInstructionQueue(edit: ConversationQueueEdit): Promise<ConversationSnapshot>;
}

export function createNativeQueuePort(controls: ConversationControls, snapshot: NativeQueuePort['snapshot'],
    execute: (action: () => Promise<ConversationSnapshot>) => Promise<ConversationSnapshot>): NativeQueuePort | undefined {
    if (!controls.enqueue || !controls.editInstructionQueue) return;
    return {snapshot, read: () => execute(() => controls.read()),
        editInstructionQueue: edit => editNativeQueue(edit, execute, controls)};
}

async function editNativeQueue(edit: ConversationQueueEdit, execute: (action: () => Promise<ConversationSnapshot>) => Promise<ConversationSnapshot>, controls: ConversationControls) {
    const operationId = randomUUID(), started = Date.now();
    try {
        const state = await execute(() => controls.editInstructionQueue!(edit));
        log.info('chat.native.queue.edit', {operationId, stage: edit.action, result: 'success', expectedRevision: edit.expectedRevision,
            revision: state.instructionQueue?.revision, itemCount: state.instructionQueue?.items.length, durationMs: Date.now() - started});
        return state;
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        log.warn('chat.native.queue.edit', {operationId, stage: edit.action, result: 'failure', expectedRevision: edit.expectedRevision,
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'QUEUE_EDIT_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}

/** The host owns queue actions; the independent view owns editing and its lifecycle. */
export function nativeQueueToolbar(queue: NativeQueuePort | undefined, options: ImageChatOptions) {
    if (!queue) return {mount: options.mountToolbar, messageActions: options.messageActions, setActive(_value: boolean) {}};
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
    return {mount, messageActions: queueMessageActions(queue, options.messageActions, () => active),
        setActive(value: boolean) {active = value; for (const update of updates) update();}};
}

function queueMessageActions(queue: NativeQueuePort, borrowed: ImageChatOptions['messageActions'], active: () => boolean): NonNullable<ImageChatOptions['messageActions']> {
    return context => {
        const host = borrowed?.(context) ?? [], state = queue.snapshot();
        const item = state?.instructionQueue?.items.find(item => context.message.id === `operation:${item.id}`);
        if (!item || item.state !== 'failed') return host;
        const expectedRevision = state!.instructionQueue!.revision;
        return [...host, {id: 'resubmit-send', label: t('session.instructions.retry'), disabled: !active() || !state?.canQueue,
            run: async () => {
                if (!active()) return;
                try {await queue.editInstructionQueue({action: 'retry', id: item.id, expectedRevision});}
                catch (error) {try {await queue.read();} catch { /* Preserve the original queue rejection. */ } throw error;}
            }}];
    };
}
