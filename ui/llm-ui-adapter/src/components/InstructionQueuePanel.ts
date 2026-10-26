import {instructionQueueLabels} from './instruction-queue-labels';
import {createModuleLogger, CHAT_ICONS, t} from '@itookit/common';
import {InstructionQueueView, type InstructionQueueSnapshot, type InstructionQueueEdit as ViewEdit} from '@itookit/llm-ui';
import {SessionCommand, type ICommandBus, type SessionInstructionQueue} from '@itookit/llm-session/contracts';

const log = createModuleLogger('session-instruction-queue');

type Projection = Omit<SessionInstructionQueue, 'items'> & {items: Array<InstructionQueueSnapshot['items'][number]
    & Partial<Pick<SessionInstructionQueue['items'][number], 'source' | 'target' | 'flowBinding'>>>};
/** Bind the shared queue view to the host's Session command port. */
export class InstructionQueuePanel {
    private readonly view: InstructionQueueView;
    private queue?: Projection;
    constructor(element: HTMLElement, commands: ICommandBus, private readonly sessionId: string,
        private readonly isCurrent: () => boolean = () => true) {
        const project = (queue: Projection): InstructionQueueSnapshot => this.project(queue);
        this.view = new InstructionQueueView(element, {
            ownerId: sessionId, removeIcon: CHAT_ICONS.delete,
            edit: edit => this.execute('edit', () => commands.execute<Projection>(SessionCommand.EditInstructionQueue, this.edit(edit)), project),
            read: () => this.execute('read', () => commands.execute<Projection>(SessionCommand.GetInstructionQueue), project),
            labels: instructionQueueLabels(),
        });
    }
    private async execute(stage: string, action: () => Promise<Projection>, project: (queue: Projection) => InstructionQueueSnapshot): Promise<InstructionQueueSnapshot> {
        const started = Date.now();
        try {
            if (!this.isCurrent()) throw Object.assign(new Error('Queue observation binding expired'), {code: 'STALE_VIEW'});
            const queue = await action();
            if (!this.isCurrent() || queue.sessionId !== this.sessionId)
                throw Object.assign(new Error('Queue observation binding changed'), {code: 'STALE_VIEW'});
            log.info('queue.operation', {sessionId: this.sessionId, stage, result: 'success', revision: queue.revision, durationMs: Date.now() - started});
            return project(queue);
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('queue.operation', {sessionId: this.sessionId, stage, result: 'failure', durationMs: Date.now() - started,
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'QUEUE_OPERATION_FAILED'});
            throw error;
        }
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
