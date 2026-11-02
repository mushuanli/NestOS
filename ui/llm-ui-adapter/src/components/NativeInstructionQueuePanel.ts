import type {ConversationControls, ConversationSnapshot} from '../contracts';
import {CHAT_ICONS, getLocale, t} from '@itookit/common';
import {InstructionQueueView, type InstructionQueueEdit, type InstructionQueueSnapshot} from '@itookit/llm-ui';

import {instructionQueueLabels} from './instruction-queue-labels';

/** Adapt the native queue directly; native admission does not use Session commands. */
export class NativeInstructionQueuePanel {
    private readonly view: InstructionQueueView;
    private readOnly = false;
    constructor(element: HTMLElement, controls: Pick<ConversationControls, 'read' | 'editInstructionQueue'>,
        show: (snapshot: ConversationSnapshot) => Promise<void>) {
        const apply = async (snapshot: ConversationSnapshot): Promise<InstructionQueueSnapshot> => {
            await show(snapshot);
            const queue = this.project(snapshot);
            if (!queue) throw new Error(t('session.instructions.editFailed'));
            return queue;
        };
        this.view = new InstructionQueueView(element, {
            ownerId: 'native', locale: getLocale(), initiallyCollapsed: true, toggleIcon: CHAT_ICONS.enqueue,
            removeIcon: CHAT_ICONS.delete, labels: instructionQueueLabels(),
            read: async () => apply(await controls.read()),
            edit: async (edit: InstructionQueueEdit) => {
                if (this.readOnly || edit.action === 'update-input') throw new Error(t('session.instructions.editFailed'));
                try {return await apply(await controls.editInstructionQueue!(edit));}
                catch (error) {
                    if ((error as {remoteCode?: string})?.remoteCode === 'HARNESS_RECOVERY_NOT_DETACHED')
                        throw new Error(t('session.instructions.recoveryBlocked'));
                    throw error;
                }
            },
        });
    }
    update(snapshot: ConversationSnapshot): void {this.view.update(this.project(snapshot));}
    private project(snapshot: ConversationSnapshot): InstructionQueueSnapshot | undefined {
        const queue = snapshot.instructionQueue;
        if (!queue) return;
        const reason = queue.reason ?? (queue.paused && queue.items.some(item => item.state === 'failed') ? 'rejected'
            : queue.paused && queue.items.some(item => item.state === 'uncertain') ? 'recovery' : undefined);
        return {ownerId: 'native', ...queue, reason};
    }
    setReadOnly(value: boolean): void {this.readOnly = value; this.view.setReadOnly(value);}
    destroy(): void {this.view.destroy();}
}
