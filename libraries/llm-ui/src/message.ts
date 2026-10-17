import type { ChatMessage, ChatOptions, ConversationSnapshot, MessageTarget } from './contracts';
import { button, disposeAll, element, errorText } from './dom';
import type { Translate } from './i18n';
import { PartView } from './parts';

export interface MessageCommands {
    edit(target: MessageTarget, text: string): Promise<void>;
    retry(target: MessageTarget): Promise<void>;
}
export class MessageView {
    readonly element = element('article', 'llm-chat__message');
    private readonly body = element('div', 'llm-chat__body');
    private readonly actions = element('div', 'llm-chat__message-actions');
    private readonly feedback = element('p', 'llm-chat__error');
    private readonly parts = new Map<string, PartView>();
    private readonly retired: Promise<void>[] = [];
    private editor?: HTMLTextAreaElement;
    private busy = false;
    constructor(private readonly options: ChatOptions, private readonly t: Translate,
        private readonly commands: MessageCommands, private readonly rendered: () => void) {
        this.element.append(this.body, this.actions, this.feedback);
    }
    update(message: ChatMessage, snapshot: ConversationSnapshot): void {
        this.element.dataset.messageId = message.id;
        this.element.dataset.role = message.role;
        this.element.dataset.state = message.state;
        const keys = new Set<string>();
        for (const part of message.parts) {
            const key = `${part.id}:${part.kind}:${part.kind === 'extension' ? part.type : ''}`; keys.add(key);
            let view = this.parts.get(key);
            if (!view) { view = new PartView(this.options, this.t, this.rendered); this.parts.set(key, view); }
            this.body.append(view.element); view.update(part, { message, snapshot });
        }
        for (const [key, view] of this.parts) if (!keys.has(key)) {
            view.element.remove(); this.retire(view.destroy()); this.parts.delete(key);
        }
        this.renderActions(message, snapshot);
    }
    private renderActions(message: ChatMessage, snapshot: ConversationSnapshot): void {
        this.actions.replaceChildren();
        const text = message.parts.flatMap(part => 'text' in part ? [part.text] : []).join('\n\n');
        this.actions.append(button(this.t('copy'), () => { void navigator.clipboard?.writeText(text).catch(this.options.onError ?? (() => {})); }));
        const target = { messageId: message.id, expectedRevision: message.revision };
        if (this.options.actions.edit && message.allowed?.includes('edit') && snapshot.allowed.includes('edit'))
            this.actions.append(button(this.t('edit'), () => this.openEditor(target, text)));
        if (this.options.actions.retry && message.allowed?.includes('retry') && snapshot.allowed.includes('retry'))
            this.actions.append(button(this.t('retry'), () => { void this.run(() => this.commands.retry(target)); }));
        this.actions.querySelectorAll('button').forEach(node => { node.disabled = this.busy; });
    }
    private openEditor(target: MessageTarget, text: string): void {
        if (this.editor) return;
        const form = element('form', 'llm-chat__edit');
        const editor = this.editor = element('textarea'); editor.value = text;
        const save = element('button', undefined, this.t('save')); save.type = 'submit';
        const close = () => { form.remove(); this.editor = undefined; };
        form.append(editor, save, button(this.t('close'), close)); this.element.append(form);
        form.addEventListener('submit', event => {
            event.preventDefault(); void this.run(async () => { await this.commands.edit(target, editor.value); close(); });
        });
        editor.focus();
    }
    private async run(work: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true; this.feedback.textContent = '';
        this.element.querySelectorAll('button').forEach(node => { node.disabled = true; });
        try { await work(); }
        catch (error) { this.feedback.textContent = errorText(error); }
        finally { this.busy = false; this.element.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    }
    private retire(disposal: Promise<void>): void { void disposal.catch(() => {}); this.retired.push(disposal); }
    destroy(): Promise<void> {
        return disposeAll([...this.parts.values()].map(part => () => part.destroy()).concat(this.retired.map(task => () => task)));
    }
}
