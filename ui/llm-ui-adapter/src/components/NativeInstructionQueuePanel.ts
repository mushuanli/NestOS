import {CHAT_ICONS, t} from '@itookit/common';
import {InstructionQueueView, type InstructionQueueEdit, type InstructionQueueSnapshot} from '@itookit/llm-ui';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
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
            ownerId: 'native', removeIcon: CHAT_ICONS.delete, labels: instructionQueueLabels(),
            read: async () => apply(await controls.read()),
            edit: async (edit: InstructionQueueEdit) => {
                if (this.readOnly || edit.action === 'update-input') throw new Error(t('session.instructions.editFailed'));
                return apply(await controls.editInstructionQueue!(edit));
            },
        });
    }
    update(snapshot: ConversationSnapshot): void {this.view.update(this.project(snapshot));}
    private project(snapshot: ConversationSnapshot): InstructionQueueSnapshot | undefined {
        return snapshot.instructionQueue ? {ownerId: 'native', ...snapshot.instructionQueue} : undefined;
    }
    setReadOnly(value: boolean): void {this.readOnly = value; this.view.setReadOnly(value);}
    destroy(): void {this.view.destroy();}
}
