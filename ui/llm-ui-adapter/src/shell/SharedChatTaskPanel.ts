import type {TaskRecord} from '@itookit/durable-kernel/contracts';
import {FlowTaskInputDialog} from './FlowTaskInputDialog';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {createInteractionCard, TtyPanel, type InteractionCard, type InteractionView, type InteractionResponse} from '@itookit/llm-ui';
import {getLocale, t} from '@itookit/common';
import type {InteractionRequest, JsonValue} from '@itookit/durable-kernel/contracts';
import type {RunAttachmentCallbacks, RunAttachmentController} from './RunAttachmentController';
import {readDirectCommandOutcome} from '../commands/direct-command';
import {inputInteraction} from './input-interaction';
import {agentQuestionAnswer} from '../components/input/agent-questions';

/** A view-owned projection of an attached task; hiding or closing never cancels execution. */
export class SharedChatTaskPanel {
    readonly element = document.createElement('aside');
    private readonly status = document.createElement('p');
    private readonly output = document.createElement('div');
    private readonly requests = document.createElement('div');
    private attachment?: RunAttachmentController;
    private card?: InteractionCard;
    private tty?: TtyPanel;
    private reading?: Promise<void>;
    private dirty = false;
    private closed = false;
    private active = true;
    private requestKey?: string;
    private readonly inputDialog?: FlowTaskInputDialog;
    private pendingInput?: InteractionRequest<JsonValue>;
    private outcomeTask?: string;
    constructor(private readonly fail: (error: unknown) => void, private readonly commands?: ICommandBus, private readonly managedTask?: (task: TaskRecord) => boolean) {
        if (commands) this.inputDialog = new FlowTaskInputDialog(commands, fail, () => {this.pendingInput = undefined; this.requests.replaceChildren(); this.element.hidden = true;});
        this.element.hidden = true; this.element.append(this.status, this.output, this.requests);
    }
    readonly callbacks: RunAttachmentCallbacks = {
        onEvent: () => this.refresh(), onWaiting: request => {void this.waiting(request).catch(this.fail);}, onError: error => this.fail(error),
        onDetached: () => {this.inputDialog?.close(); this.pendingInput = undefined; this.card?.destroy(); this.card = undefined; this.requestKey = undefined; this.requests.replaceChildren(); this.element.hidden = true;},
    };
    bind(attachment: RunAttachmentController): void {this.attachment = attachment;}
    private refresh(): void {
        if (this.closed || !this.active) return;
        this.dirty = true;
        this.reading ??= this.read().catch(error => this.fail(error)).finally(() => {this.reading = undefined; if (this.dirty) this.refresh();});
    }
    private async read(): Promise<void> {
        while (this.dirty && !this.closed && this.active) {
            this.dirty = false; const attachment = this.attachment, revision = attachment?.revision;
            const task = await attachment?.current();
            if (!task || this.closed || !this.active || attachment !== this.attachment || revision !== attachment?.revision) return;
            if (this.pendingInput && task.interactions?.[this.pendingInput.id]?.status !== 'pending') {
                this.inputDialog?.close(); this.pendingInput = undefined; this.requests.replaceChildren();
            } else if (this.pendingInput) this.showStructuredInput(this.pendingInput);
            this.element.hidden = false; this.status.textContent = this.commands ? '' : `${task.id} · ${task.status}`;
            const outcome = readDirectCommandOutcome(task);
            if (this.commands && !outcome && !this.pendingInput && !this.card) this.element.hidden = true;
            if (!outcome || this.outcomeTask === task.id) continue;
            this.outcomeTask = task.id; this.tty?.destroy(); this.output.replaceChildren();
            const terminal = this.tty = new TtyPanel(this.output, task.id, outcome.command, undefined, {locale: getLocale()});
            terminal.appendOutput(outcome.output); terminal.finalize(null);
        }
    }
    private async waiting(request: InteractionRequest<JsonValue>): Promise<void> {
        if (this.closed || !this.active) return;
        const attachment = this.attachment, revisionAtStart = attachment?.revision;
        const task = this.managedTask ? await attachment?.current() : undefined;
        if (this.closed || !this.active || attachment !== this.attachment || attachment?.revision !== revisionAtStart) return;
        if (this.inputDialog && this.attachment) {
            if (this.showStructuredInput(request)) return;
            this.inputDialog.close(); this.pendingInput = undefined;
            if (!this.managedTask || task && this.managedTask(task)) {this.element.hidden = true; return;}
        }
        const revision = this.attachment?.revision ?? 0, key = `${revision}:${request.id}`; if (key === this.requestKey) return;
        this.requestKey = key; this.card?.destroy(); this.requests.replaceChildren(); this.element.hidden = false;
        const input = inputInteraction(request, this.attachment?.revision ?? 0);
        const projection: InteractionView = request.kind === 'approval' ? {id: request.id, revision, state: 'pending',
            kind: 'approval', title: input.prompt, detail: input.details, decisions: [{id: 'approved', label: t('action.confirm')}, {id: 'rejected', label: t('action.cancel')}], note: true}
            : {id: request.id, revision, state: 'pending', kind: 'input', title: input.prompt, detail: input.details,
                fields: input.fields?.length ? input.fields : [{id: 'answer', label: input.prompt, kind: 'text', required: true}]};
        this.card = createInteractionCard(projection, response => this.respond(request, key, response, revision), {locale: getLocale()}); this.requests.append(this.card.element);
    }
    private showStructuredInput(request: InteractionRequest<JsonValue>): boolean {
        const attachment = this.attachment!;
        if (!this.inputDialog!.show(request, attachment, () => !this.closed && this.active && attachment === this.attachment)) return false;
        this.pendingInput = request; this.element.hidden = false; this.status.textContent = '';
        const open = document.createElement('button'); open.type = 'button'; open.textContent = t('flow.editor.openInput');
        open.onclick = () => {if (this.active && !this.closed) this.showStructuredInput(request);};
        this.requests.replaceChildren(open); return true;
    }
    private async respond(request: InteractionRequest<JsonValue>, key: string, response: InteractionResponse, revision: number): Promise<void> {
        if (this.closed || !this.active || this.requestKey !== key || !this.attachment) throw new Error('Task interaction binding expired');
        const card = this.card; card?.setPending(true);
        try {
            if (response.kind === 'approval') await this.attachment.respondApproval(request.id, response.decisionId === 'approved', response.note ?? '', revision);
            else {
                const fields = inputInteraction(request, this.attachment.revision).fields;
                const value = fields?.length ? agentQuestionAnswer(fields, response) : response.values.answer ?? '';
                await this.attachment.respondInput(request.id, value as JsonValue, revision);
            }
            if (this.requestKey === key) {this.card?.destroy(); this.card = undefined; this.requestKey = undefined; this.requests.replaceChildren();}
        } finally {if (this.card === card) card?.setPending(false);}
    }
    setActive(active: boolean): void {this.active = active; if (!active) this.inputDialog?.close(); else if (this.pendingInput) this.showStructuredInput(this.pendingInput); if (!active) this.card?.setPending(true); else {this.card?.setPending(false); this.refresh();}}
    destroy(): void {if (this.closed) return; this.closed = true; this.dirty = false; this.inputDialog?.close(); this.card?.destroy(); this.tty?.destroy(); this.element.remove();}
}
