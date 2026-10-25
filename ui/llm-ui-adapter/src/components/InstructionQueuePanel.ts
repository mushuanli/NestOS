import {instructionQueueLabels} from './instruction-queue-labels';
import {CHAT_ICONS, t} from '@itookit/common';
import {InstructionQueueView, type InstructionQueueSnapshot, type InstructionQueueEdit as ViewEdit} from '@itookit/llm-ui';
import {SessionCommand, type ICommandBus, type SessionInstructionQueue} from '@itookit/llm-session/contracts';

type Projection = Omit<SessionInstructionQueue, 'items'> & {items: Array<InstructionQueueSnapshot['items'][number]
    & Partial<Pick<SessionInstructionQueue['items'][number], 'source' | 'target' | 'flowBinding'>>>};
/** Bind the shared queue view to the host's Session command port. */
export class InstructionQueuePanel {
    private readonly view: InstructionQueueView;
    private queue?: Projection;
    constructor(element: HTMLElement, commands: ICommandBus, private readonly sessionId: string) {
        const project = (queue: Projection): InstructionQueueSnapshot => this.project(queue);
        this.view = new InstructionQueueView(element, {
            ownerId: sessionId, removeIcon: CHAT_ICONS.delete,
            edit: async edit => project(await commands.execute<Projection>(SessionCommand.EditInstructionQueue, this.edit(edit))),
            read: async () => project(await commands.execute<Projection>(SessionCommand.GetInstructionQueue)),
            labels: instructionQueueLabels(),
        });
    }
    update(queue?: Projection): void {
        if (queue?.sessionId === this.sessionId) this.view.update(this.project(queue));
    }
    private project(queue: Projection): InstructionQueueSnapshot {
        if (queue.sessionId === this.sessionId && (!this.queue || queue.revision >= this.queue.revision)) this.queue = queue;
        return {ownerId: queue.sessionId, revision: queue.revision, paused: queue.paused, reason: queue.reason,
            items: queue.items.map(item => ({id: item.id, text: item.text, state: item.state, agentId: item.agentId,
            error: item.error, files: item.files.map(file => ({name: file.name})),
            ...(item.target ? {targetLabel: `${item.target.kind === 'flow' ? 'Flow' : 'Agent'} · ${item.flowBinding?.agent?.name ?? item.flowBinding?.definition.name ?? item.target.id}`} : {}),
            ...(item.source && item.flowBinding ? {input: item.source.kind === 'arguments' ? item.source.value : item.source.values,
                textEditable: item.source.kind === 'composer'} : {})}))};
    }
    private edit(edit: ViewEdit): unknown {
        if (edit.action !== 'update-input') return edit;
        const source = this.queue?.items.find(item => item.id === edit.id)?.source;
        if (!source) throw new Error(t('callable.input.unavailable'));
        return {action: 'update-input', id: edit.id, expectedRevision: edit.expectedRevision,
            source: source.kind === 'arguments' ? {kind: 'arguments', value: edit.value}
                : {...source, text: edit.text, values: edit.value}};
    }
    setReadOnly(value: boolean): void {this.view.setReadOnly(value);}
    destroy(): void {this.view.destroy();}
}
