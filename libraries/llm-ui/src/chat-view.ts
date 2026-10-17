import { DefaultPrintService } from '@itookit/mdxeditor';
import type { ActionName, ChatMessage, ChatOptions, ChatView, ConversationSnapshot, JsonValue,
    MessageTarget, MountedToolbar, OperationContext, OperationReceipt, OperationRecord } from './contracts';
import { Composer } from './composer';
import { DraftWriter } from './draft';
import { button, disposeAll, element, errorText } from './dom';
import { InteractionCard } from './interactions';
import { translator } from './i18n';
import { MessageView } from './message';
import { FlowFeature } from './flow-feature';

export class ChatController implements ChatView {
    private readonly root = element('section', 'llm-chat');
    private readonly heading = element('h2', 'llm-chat__title');
    private readonly status = element('span', 'llm-chat__status');
    private readonly toolbar = element('div', 'llm-chat__toolbar');
    private readonly history = element('div', 'llm-chat__history');
    private readonly requests = element('div', 'llm-chat__interactions');
    private readonly prompts = element('nav', 'llm-chat__prompts');
    private readonly operationStatus = element('div', 'llm-chat__operations');
    private readonly earlier: HTMLButtonElement;
    private readonly cancel: HTMLButtonElement;
    private readonly composer: Composer;
    private readonly writer: DraftWriter;
    private readonly flow: FlowFeature;
    private readonly rows = new Map<string, { view: MessageView; message: ChatMessage; permissions: string }>();
    private readonly cards = new Map<string, InteractionCard>();
    private readonly disposers: (() => void | Promise<void>)[] = [];
    private readonly reads = new Set<AbortController>();
    private readonly confirming = new Set<string>();
    private readonly inFlight = new Set<string>();
    private readonly t;
    private snapshot!: ConversationSnapshot;
    private binding?: { viewId: string; conversationId: string };
    private slot?: MountedToolbar;
    private active = true;
    private closed = false;
    private following = true;
    private reading = false;
    private sending = false;
    private disposed?: Promise<void>;
    constructor(private readonly container: HTMLElement, private readonly options: ChatOptions) {
        this.t = translator(options.locale, options.translate);
        this.writer = new DraftWriter(options.saveDraft, error => this.report(error));
        this.flow = new FlowFeature(this.t('flow'), options.flow, error => this.report(error));
        this.composer = new Composer(options, this.t, draft => {
            this.writer.changed(draft);
            try { options.onDraftChange?.(draft); } catch (error) { this.report(error); }
            if (this.snapshot && !this.closed) this.updateAvailability();
        }, () => { void this.submit().catch(error => this.report(error)); });
        this.earlier = button(this.t('earlier'), () => { void this.loadEarlier(); });
        this.cancel = button(this.t('cancel'), () => { void this.cancelExecution().catch(error => this.report(error)); });
        this.layout();
    }
    initialize(): void {
        if (this.options.features?.flow && !this.options.flow) throw new Error('Flow options are required to enable the Flow feature');
        void this.flow.setEnabled(this.options.features?.flow ?? false);
        if (['send', 'cancel', 'edit', 'retry', 'respond'].some(kind => !!this.options.actions[kind as ActionName])
            && !this.options.actions.reconcile) throw new Error('Mutating hosts must provide operation reconciliation');
        this.disposers.push(this.options.source.subscribe(() => this.changed()));
        this.disposers.push(this.options.operations.subscribe(() => this.operationChanged()));
        this.changed();
        this.slot = this.options.mountToolbar?.(this.toolbar, { snapshot: this.snapshot, view: this });
    }
    private layout(): void {
        const header = element('header', 'llm-chat__header'); header.append(this.heading, this.status, this.cancel, this.flow.button);
        if (this.options.source.refresh) header.append(button(this.t('refresh'), () => {
            void this.options.source.refresh!().catch(error => this.report(error));
        }));
        header.append(button(this.t('prompts'), () => { this.prompts.hidden = !this.prompts.hidden; }));
        header.append(button(this.t('print'), () => { void this.print().catch(error => this.report(error)); }));
        this.prompts.hidden = true; this.prompts.setAttribute('aria-label', this.t('prompts'));
        this.history.setAttribute('role', 'log');
        this.history.addEventListener('scroll', () => { this.following = this.history.scrollHeight - this.history.clientHeight - this.history.scrollTop < 32; });
        this.root.append(header, this.toolbar, this.prompts, this.earlier, this.history, this.flow.pane, this.requests, this.operationStatus, this.composer.element);
        this.container.append(this.root);
    }
    private changed(): void {
        if (this.closed) return;
        const snapshot = this.options.source.getSnapshot();
        if (!this.binding) this.binding = { viewId: snapshot.viewId, conversationId: snapshot.conversationId };
        if (snapshot.viewId !== this.binding.viewId || snapshot.conversationId !== this.binding.conversationId) return;
        if (this.snapshot && snapshot.revision < this.snapshot.revision) return;
        this.snapshot = snapshot;
        this.confirmMessages(); this.operationChanged();
    }
    private confirmMessages(): void {
        const records = this.records();
        for (const message of this.snapshot.messages) {
            if (message.role !== 'user' || message.acceptance !== 'confirmed' || !message.submissionId) continue;
            const record = records.find(item => item.kind === 'send' && item.context.operationId === message.submissionId);
            if (!record || record.observedUserMessageId || this.confirming.has(message.submissionId)) continue;
            const id = message.submissionId; this.confirming.add(id);
            void this.options.operations.settle({ status: 'accepted', operationId: id, observedUserMessageId: message.id })
                .catch(error => this.report(error)).finally(() => this.confirming.delete(id));
        }
    }
    private records(): readonly OperationRecord[] {
        return this.options.operations.getSnapshot().filter(record => record.conversationId === this.snapshot.conversationId);
    }
    private operationChanged(): void {
        if (this.closed || !this.snapshot) return;
        this.confirmMessages();
        for (const record of this.records()) if (record.kind === 'send' && record.status === 'accepted' && record.draft)
            this.composer.accept(record.draft);
        if (this.active) this.render();
    }
    private render(): void {
        this.heading.textContent = this.snapshot.title;
        this.status.textContent = this.snapshot.error?.message ?? this.t(this.snapshot.loading ? 'loading' : this.snapshot.connection);
        this.renderHistory(); this.renderInteractions(); this.renderOperations(); this.updateAvailability();
        try { this.slot?.update?.({ snapshot: this.snapshot, view: this }); } catch (error) { this.options.onError?.(error); }
    }
    private updateAvailability(): void {
        this.composer.update(this.snapshot, !this.sending && this.can('send') && !this.records().some(record => record.kind === 'send' && unresolved(record)));
        this.cancel.hidden = !this.can('cancel') || !this.snapshot.executionRef;
        this.cancel.disabled = this.records().some(record => record.kind === 'cancel' && unresolved(record));
        this.earlier.hidden = !this.snapshot.hasEarlier || !this.options.actions.loadEarlier;
        this.earlier.disabled = this.reading;
    }
    private renderHistory(): void {
        const records = this.records().filter(record => record.kind === 'send');
        const messages = this.snapshot.messages.filter(message => !(message.role === 'user' && message.acceptance === 'optimistic'
            && records.some(record => record.context.operationId === message.submissionId)));
        const temporary = records.filter(record => !record.observedUserMessageId && !messages.some(message => message.role === 'user'
            && message.acceptance === 'confirmed' && message.submissionId === record.context.operationId)).map(record => temporaryMessage(record));
        this.syncMessages([...messages, ...temporary]);
        this.prompts.replaceChildren();
        for (const message of messages) if (message.role === 'user') {
            const text = message.parts.flatMap(part => part.kind === 'markdown' ? [part.text] : []).join(' ');
            this.prompts.append(button(text.slice(0, 160), () => this.rows.get(message.id)?.view.element.scrollIntoView?.({ block: 'center' })));
        }
    }
    private syncMessages(messages: readonly ChatMessage[]): void {
        const ids = new Set(messages.map(message => message.id));
        for (const [id, row] of this.rows) if (!ids.has(id)) {
            row.view.element.remove(); this.retire(row.view.destroy()); this.rows.delete(id);
        }
        let next = this.history.firstElementChild;
        for (const message of messages) {
            const row = this.messageRow(message);
            if (row.view.element !== next) this.history.insertBefore(row.view.element, next);
            next = row.view.element.nextElementSibling;
        }
        this.follow();
    }
    private messageRow(message: ChatMessage) {
        let row = this.rows.get(message.id);
        const permissions = this.snapshot.allowed.join(',');
        if (!row) {
            const view = new MessageView(this.options, this.t, {
                edit: (target, text) => this.edit(target, text), retry: target => this.retry(target),
            }, () => this.follow());
            row = { view, message, permissions }; this.rows.set(message.id, row); view.update(message, this.snapshot);
        } else if (message.revision !== row.message.revision || permissions !== row.permissions) {
            row.message = message; row.permissions = permissions; row.view.update(message, this.snapshot);
        }
        return row;
    }
    private renderInteractions(): void {
        const keys = new Set<string>();
        for (const request of this.snapshot.interactions) {
            const key = `${request.id}:${request.revision}:${request.state}`; keys.add(key);
            let card = this.cards.get(key);
            if (!card) {
                card = new InteractionCard(request, this.t, response => this.perform('respond', { id: request.id, revision: request.revision, response } as unknown as JsonValue,
                    context => this.options.actions.respond!({ id: request.id, revision: request.revision, response }, context)));
                this.cards.set(key, card);
            }
            const operation = this.records().find(record => record.kind === 'respond'
                && typeof record.input === 'object' && record.input !== null && 'id' in record.input
                && record.input.id === request.id && record.input.revision === request.revision && record.status !== 'rejected');
            card.setPending(!this.can('respond') || !!operation, operation ? this.t(operation.status === 'submitting' ? 'pending' : operation.status) : undefined);
            this.requests.append(card.element);
        }
        for (const [key, card] of this.cards) if (!keys.has(key)) { card.destroy(); this.cards.delete(key); }
    }
    private can(kind: ActionName): boolean { return !!this.options.actions[kind] && this.snapshot.allowed.includes(kind); }
    private renderOperations(): void {
        this.operationStatus.replaceChildren();
        for (const record of this.records()) {
            if (record.status === 'accepted') continue;
            const row = element('p', undefined, `${this.t(record.status === 'submitting' ? 'pending' : record.status)} ${record.message ?? ''}`);
            row.dataset.operationId = record.context.operationId;
            if (unresolved(record) && this.options.actions.reconcile) row.append(button(this.t('reconcile'), () => {
                void this.reconcile(record.context.operationId).catch(error => this.report(error));
            }));
            this.operationStatus.append(row);
        }
    }
    async submit(): Promise<void> {
        if (this.closed || this.sending || !this.can('send') || this.composer.uploading) return;
        if (this.records().some(record => record.kind === 'send' && unresolved(record))) return;
        const draft = this.composer.getDraft();
        if (!draft.text.trim() && !draft.attachments.length) return;
        const input = { text: draft.text, attachments: draft.attachments.map(item => item.file), selection: this.composer.getSelection() };
        this.sending = true; this.updateAvailability();
        try { await this.perform('send', input as unknown as JsonValue, context => this.options.actions.send!(input, context), draft); }
        finally { this.sending = false; if (!this.closed) this.updateAvailability(); }
    }
    private async perform(kind: ActionName, input: JsonValue, action: (context: OperationContext) => Promise<OperationReceipt>,
        draft?: import('./contracts').ComposerDraft): Promise<void> {
        if (this.closed || !this.can(kind)) throw new Error('Operation is unavailable');
        const key = operationKey(kind, input);
        if (this.inFlight.has(key)) return;
        if (this.records().some(record => operationKey(record.kind, record.input) === key
            && (unresolved(record) || kind === 'respond' && record.status === 'accepted')))
            throw new Error('Operation is awaiting reconciliation or an updated request');
        this.inFlight.add(key);
        try { await this.dispatch(kind, input, action, draft); }
        finally { this.inFlight.delete(key); }
    }
    private async dispatch(kind: ActionName, input: JsonValue, action: (context: OperationContext) => Promise<OperationReceipt>,
        draft?: import('./contracts').ComposerDraft): Promise<void> {
        const context = { viewId: this.snapshot.viewId, operationId: crypto.randomUUID() };
        await this.options.operations.register({ context, conversationId: this.snapshot.conversationId, kind, input, draft, status: 'submitting' });
        let receipt: OperationReceipt;
        try { receipt = await action(context); }
        catch (error) { receipt = { status: 'unknown', operationId: context.operationId, message: errorText(error) }; }
        if (receipt.operationId !== context.operationId) receipt = { status: 'unknown', operationId: context.operationId, message: 'Mismatched receipt identity' };
        await this.options.operations.settle(receipt);
        const settled = this.options.operations.getSnapshot().find(record => record.context.operationId === context.operationId)!;
        if (settled.status !== 'accepted') throw new Error(settled.message ?? this.t('unknown'));
    }
    async reconcile(operationId: string): Promise<void> {
        const record = this.records().find(item => item.context.operationId === operationId);
        if (!record || !this.options.actions.reconcile || !unresolved(record)) return;
        const receipt = await this.options.actions.reconcile(operationId);
        if (receipt.operationId !== operationId) throw new Error('Mismatched reconciliation identity');
        await this.options.operations.settle(receipt);
    }
    private async cancelExecution(): Promise<void> {
        const target = this.snapshot.executionRef;
        if (!target || this.cancel.disabled) return;
        await this.perform('cancel', target, context => this.options.actions.cancel!(target, context));
    }
    private edit(target: MessageTarget, text: string): Promise<void> {
        return this.perform('edit', { ...target, text }, context => this.options.actions.edit!(target, text, context));
    }
    private retry(target: MessageTarget): Promise<void> {
        return this.perform('retry', { ...target }, context => this.options.actions.retry!(target, context));
    }
    private async loadEarlier(): Promise<void> {
        if (this.reading || this.closed || !this.options.actions.loadEarlier) return;
        const abort = new AbortController(); this.reads.add(abort); this.reading = true; this.updateAvailability();
        const height = this.history.scrollHeight, top = this.history.scrollTop; this.following = false;
        try { await this.options.actions.loadEarlier({ signal: abort.signal }); }
        catch (error) { if (!this.closed) this.report(error); }
        finally {
            this.reads.delete(abort); this.reading = false;
            if (!this.closed) { this.history.scrollTop = top + this.history.scrollHeight - height; this.updateAvailability(); }
        }
    }
    private follow(): void { if (!this.closed && this.active && this.following) this.history.scrollTop = this.history.scrollHeight; }
    private report(error: unknown): void {
        if (!this.closed) this.composer.feedback.textContent = errorText(error);
        this.options.onError?.(error);
    }
    private retire(task: Promise<void>): void { void task.catch(() => {}); this.disposers.push(() => task); }
    private async print(): Promise<void> {
        const service = new DefaultPrintService();
        try { await service.printFromHtml(this.history.innerHTML, { title: this.snapshot.title, locale: this.options.locale }); }
        finally { service.destroy(); }
    }
    setActive(active: boolean): void { if (this.closed) return; this.active = active; this.flow.setActive(active); if (active) this.changed(); }
    setFlowEnabled(enabled: boolean): Promise<void> { return this.flow.setEnabled(enabled); }
    focus(): void { if (!this.closed && this.active) this.composer.textarea.focus(); }
    getDraft() { return this.composer.getDraft(); }
    setText(text: string): void { this.composer.setText(text); }
    addFiles(files: readonly File[]): Promise<void> { return this.composer.addFiles(files); }
    flushDraft(): Promise<void> { return this.writer.flush(); }
    destroy(): Promise<void> {
        if (this.disposed) return this.disposed;
        this.closed = true; this.composer.destroy(); this.writer.stop();
        for (const abort of this.reads) abort.abort();
        const steps = [...this.disposers, () => this.writer.flush(), () => this.slot?.destroy(), () => this.flow.destroy(),
            ...[...this.rows.values()].map(row => () => row.view.destroy()),
            ...[...this.cards.values()].map(card => () => card.destroy()), () => this.root.remove()];
        return this.disposed = disposeAll(steps);
    }
}
function unresolved(record: OperationRecord): boolean { return record.status === 'submitting' || record.status === 'unknown'; }
function operationKey(kind: OperationRecord['kind'], input: JsonValue): string {
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        if ((kind === 'edit' || kind === 'retry') && 'messageId' in input) return `message:${input.messageId}`;
        if (kind === 'respond' && 'id' in input && 'revision' in input) return `respond:${input.id}:${input.revision}`;
    }
    return `${kind}:${JSON.stringify(input)}`;
}
function temporaryMessage(record: OperationRecord): ChatMessage {
    return { id: `operation:${record.context.operationId}`, revision: ['submitting', 'accepted', 'unknown', 'rejected'].indexOf(record.status),
        role: 'user', state: record.status === 'rejected' ? 'failed' : 'pending',
        parts: [{ id: 'text', kind: 'markdown', text: record.draft?.text ?? '' },
            { id: 'status', kind: 'tool', name: record.status, summary: record.message ?? '', state: record.status === 'rejected' ? 'failed' : 'running' },
            ...(record.draft?.attachments ?? []).map(item => ({ id: item.id, kind: 'attachment' as const, file: item.file }))],
    };
}
