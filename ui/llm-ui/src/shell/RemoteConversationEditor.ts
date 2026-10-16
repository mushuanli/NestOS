import { BaseSettingsEditor, conversationStatus, type ConversationControls, type ConversationSnapshot, type EditorOptions, type EditorEvent, type EditorEventCallback, type EditorEventMap } from '@itookit/ui-common';
import { t } from '@itookit/common';
import { conversationRequests } from './remote-interactions';
import { ConversationWorkspaceView } from './ConversationWorkspaceView';
import { RemoteBranches } from './remote-branches';
import { remoteRounds } from './remote-rounds';
import { prepareRemoteAttachments } from './remote-attachments';
import type { ChatSubmission } from '../domain/submission';

/** Native histories remain remote; this editor only owns a view and input draft. */
export class RemoteConversationEditor extends BaseSettingsEditor<ConversationControls> {
    private view!: ConversationWorkspaceView;
    private branches?: RemoteBranches;
    private snapshot?: ConversationSnapshot;
    private closed = false;
    private releaseUpdates?: () => void;
    private updateTimer?: ReturnType<typeof setTimeout>;
    private working = false;
    private timer?: ReturnType<typeof setTimeout>;
    private loadingHistory = false;
    private historyError = '';
    private tail: Promise<unknown> = Promise.resolve();
    private announced?: string;
    private savedDraft = '';
    private restoredDraft = false;
    private draftFiles: File[] = [];
    private savedFiles: File[] = [];
    private submittedDraft?: {text: string; files: File[]};
    private submission?: ChatSubmission;
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    private interactionKey = '';
    constructor(container: HTMLElement, controls: ConversationControls, options: EditorOptions) { super(container, controls, options); }
    async init(container: HTMLElement) {
        this.container = container;
        const abort = () => { void this.service.close().catch(() => {}); };
        this.options.signal?.throwIfAborted();
        this.options.signal?.addEventListener('abort', abort, {once: true});
        try { await this.render(); this.options.signal?.throwIfAborted(); }
        finally { this.options.signal?.removeEventListener('abort', abort); }
    }
    async render() {
        this.layout();
        try { await this.show(await this.service.read()); } catch (error) { this.showError(error); }
        if (!this.closed) {
            if (this.service.subscribe) this.releaseUpdates = this.service.subscribe(() => this.queueUpdate());
            else this.schedule();
        }
    }
    private layout() {
        this.view = new ConversationWorkspaceView(this.container, this.options, {
            send: (text, files) => this.sendText(text, files),
            attachments: this.options.readOnly ? undefined : this.service.snapshot?.().attachments,
            stop: () => { void this.run(() => this.service.interrupt()).catch(() => {}); },
            refresh: () => { void this.run(() => this.service.read()).catch(() => {}); },
            reconcile: () => { void this.run(async () => {
                const snapshot = await this.service.reconcile();
                if (this.submission?.state === 'unknown' && !snapshot.pending && !snapshot.submittedTurnId)
                    this.submission = {...this.submission, state: 'failed', error: t('chat.submission.unconfirmed')};
                return snapshot;
            }).catch(() => {}); },
            earlier: () => { this.historyError = ''; void this.loadHistory(); },
            changed: files => { this.draftFiles = files ?? []; this.emit('interactiveChange', undefined); }, copy: () => this.getText(),
            rename: title => {
                if (title !== this.snapshot?.title && this.snapshot?.canRename && this.service.rename)
                    void this.run(() => this.service.rename!(title)).catch(() => {});
            },
        });
        this.branches = new RemoteBranches(this.service, this.options, action => this.run(action), error => this.showError(error));
        this.container.querySelector('#llm-branch-indicator')!.append(this.branches.element);
    }
    private async show(snapshot: ConversationSnapshot) {
        if (this.closed) return;
        if (this.snapshot?.pending && !snapshot.pending && snapshot.draft === '' && !snapshot.draftAttachments?.length && this.submittedDraft) {
            this.acceptSubmission(this.submittedDraft.text, this.submittedDraft.files); this.submittedDraft = undefined;
        }
        this.snapshot = snapshot;
        this.restoreDraft(snapshot);
        if (this.submission?.state === 'unknown' && !snapshot.pending && snapshot.submittedTurnId) {
            this.submission = {...this.submission, state: 'accepted', messageId: this.submittedMessageId(snapshot.submittedTurnId), error: undefined};
        }
        await this.view.history.show(snapshot.messages, this.submission);
        if (this.closed) return;
        if (snapshot.sessionId && !snapshot.pending && snapshot.sessionId !== this.announced) {
            this.announced = snapshot.sessionId; this.options.onConversationSession?.(snapshot.sessionId);
        }
        const key = JSON.stringify(snapshot.requests);
        if (key !== this.interactionKey) {
            this.interactionKey = key;
            this.view.interactions.replaceChildren(...conversationRequests(snapshot.requests, (id, response) => this.run(() => this.service.respond(id, response))));
        }
        this.view.setTitle(snapshot.title);
        this.view.setSessionTimes(snapshot.createdAt, snapshot.updatedAt);
        this.view.setUsage(snapshot);
        const status = conversationStatus(snapshot.observation ?? {execution: snapshot.requests.some(r => r.kind === 'approval') ? 'waiting-approval'
            : snapshot.requests.some(r => r.kind === 'input') ? 'waiting-input' : snapshot.active || snapshot.canInterrupt ? 'running' : 'unknown',
            updatedAt: snapshot.updatedAt, connection: snapshot.disconnected ? 'offline' : 'online', stale: snapshot.gap, receiptUnknown: snapshot.pending, source: 'history', observedAt: 0}, Date.now(), {inferActivity: false});
        const submission = this.submission;
        this.view.setStatus(submission && submission.state !== 'accepted'
            ? [t(`chat.submission.${submission.state}`), submission.error].filter(Boolean).join(' ') : status.text,
            submission?.state === 'failed' ? 'failed' : submission && submission.state !== 'accepted' ? 'queued' : status.indicator);
        this.updateControls();
    }
    private restoreDraft(snapshot: ConversationSnapshot) {
        if (this.restoredDraft) return;
        this.savedDraft = snapshot.draft ?? '';
        if (!this.options.initialInputState?.text) {
            this.draftFiles = (snapshot.draftAttachments ?? []).map(attachment => {
                const content = attachment.kind === 'text' ? attachment.content : Uint8Array.from(atob(attachment.content.split(',')[1] ?? ''), char => char.charCodeAt(0));
                return new File([content], attachment.name, {type: attachment.mimeType ?? 'text/plain'});
            });
            this.view.input.restoreDraft(this.savedDraft, this.draftFiles, 'remote:native');
            this.savedFiles = [...this.draftFiles];
        }
        if (snapshot.pending) this.submittedDraft = {text: this.savedDraft, files: [...this.draftFiles]};
        this.restoredDraft = true;
    }
    private updateControls() {
        this.container.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.disabled = this.working || this.loadingHistory;
        this.view.setRenameAvailability(!this.working && !this.options.readOnly && !!this.snapshot?.canRename && !!this.service.rename);
        if (this.snapshot) this.branches?.update(this.snapshot, this.working);
        this.view.earlier.hidden = !this.snapshot?.hasEarlier || !this.service.loadEarlier;
        this.view.earlier.disabled = this.working || this.loadingHistory;
        this.view.setHistoryProgress(this.snapshot?.messages.length ?? 0, !!this.snapshot?.hasEarlier, this.loadingHistory, this.historyError);
        this.view.input.setLoading(!!this.snapshot?.canInterrupt);
        this.view.input.setAvailability({
            canSend: !this.working && this.submission?.state !== 'unknown' && !this.options.readOnly && !!this.snapshot?.canSend,
            canInterrupt: !this.working && !this.options.readOnly && !!this.snapshot?.canInterrupt,
        });
        this.view.reconcile.disabled = this.working || !this.snapshot?.pending && this.submission?.state !== 'unknown';
        for (const button of this.view.interactions.querySelectorAll('button')) button.disabled = this.working || !!this.options.readOnly || !this.snapshot?.canRespond;
    }
    private async loadHistory(): Promise<void> {
        if (this.closed || this.working || this.loadingHistory || !this.snapshot?.hasEarlier || !this.service.loadEarlier) return;
        this.loadingHistory = true; this.updateControls();
        const operation = this.tail.then(async () => {
            try { if (!this.closed && !this.working) await this.show(await this.service.loadEarlier!()); }
            catch (error) { if (!this.closed) this.historyError = error instanceof Error ? error.message : String(error); }
            finally { this.loadingHistory = false; if (!this.closed) { this.updateControls(); } }
        });
        this.tail = operation.catch(() => {}); await this.tail;
    }
    async sendText(text: string, files: File[] = []): Promise<void> {
        if (!text.trim() && !files.length) return;
        if (this.closed || this.working || this.submission?.state === 'unknown' || this.options.readOnly || !this.snapshot?.canSend) throw new Error(t('harness.remoteBusy'));
        this.submission = {id: crypto.randomUUID(), text: text.trim() || t('harness.attachmentPrompt'), timestamp: Date.now(), state: 'submitting'};
        await this.run(async () => {
            try {
                this.view.history.view.setSubmission(this.submission);
                this.view.history.view.scrollToBottom(true);
                this.view.setStatus(t('chat.submission.submitting'), 'queued');
                const attachments = await prepareRemoteAttachments(files, this.snapshot?.attachments ?? []);
                this.submittedDraft = {text, files: [...files]};
                const result = attachments.length ? await this.service.send(text.trim() || t('harness.attachmentPrompt'), attachments) : await this.service.send(text);
                const accepted = !!result.submittedTurnId || !result.pending;
                this.submission = {...this.submission!, state: accepted ? 'accepted' : 'unknown', messageId: this.submittedMessageId(result.submittedTurnId)};
                if (!this.closed && accepted) { this.acceptSubmission(text, files); this.submittedDraft = undefined; }
                return result;
            } catch (error) {
                this.submission = {...this.submission!, state: this.service.snapshot?.().pending || (error as {outcome?: string})?.outcome === 'unknown' ? 'unknown' : 'failed',
                    error: this.sendError(error)};
                if (!this.closed) { this.view.history.view.setSubmission(this.submission); this.showError(error); }
                throw error;
            }
        });
        if (this.submission?.state === 'unknown') throw new Error(t('chat.submission.unknown'));
    }
    private submittedMessageId(turnId?: string): string | undefined {
        return turnId ? remoteRounds([{id: 'ack', role: 'user', text: '', turnId}])[0]?.id : undefined;
    }
    private sendError(error: unknown): string | undefined {
        const code = (error as {remoteCode?: string})?.remoteCode;
        return code === 'HARNESS_SESSION_BUSY' || error instanceof Error && error.message.includes('HARNESS_SESSION_BUSY')
            ? t('chat.submission.occupied') : error instanceof Error ? error.message : undefined;
    }
    private acceptSubmission(text: string, files: File[]) {
        this.view.input.acceptSubmittedDraft(text, files);
        this.draftFiles = this.draftFiles.filter(file => !files.includes(file)); this.savedFiles = [];
        this.savedDraft = ''; this.emit(this.isDirty() ? 'interactiveChange' : 'saved', undefined);
    }
    private async run(action: () => Promise<ConversationSnapshot>) {
        if (this.closed || this.working) return;
        this.working = true; this.updateControls();
        const operation = this.tail.then(async () => {
            try { await this.show(await action()); } catch (error) {
                await this.observeFailure(error);
                try { await this.show(await this.service.read()); } catch { /* Keep the last snapshot and draft. */ }
                if (!this.closed) this.showError(error);
                throw error;
            } finally { this.working = false; if (!this.closed) { this.updateControls(); } }
        });
        this.tail = operation.catch(() => {});
        await operation;
    }
    private async observeFailure(error: unknown): Promise<void> {
        const snapshot = this.service.snapshot?.();
        if (snapshot) { await this.show(snapshot); return; }
        if (this.snapshot && error && typeof error === 'object' && 'outcome' in error && error.outcome === 'unknown') {
            this.snapshot = {...this.snapshot, pending: true, canSend: false, canInterrupt: false, canRespond: false, canFork: false};
        }
    }
    private showError(error: unknown) {
        if (this.submission?.state === 'failed' || this.submission?.state === 'unknown') {
            this.view.setStatus([t(`chat.submission.${this.submission.state}`), this.submission.error].filter(Boolean).join(' '), this.submission.state === 'failed' ? 'failed' : 'queued'); return;
        }
        this.view.setStatus(this.snapshot?.pending ? t('harness.unknown') : `${t('harness.failed')} ${error instanceof Error ? error.message : ''}`, this.snapshot?.pending ? 'queued' : 'failed');
    }
    private queueUpdate(): void {
        if (this.closed || this.updateTimer) return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            if (this.working) { this.queueUpdate(); return; }
            const work = this.tail.then(async () => { if (!this.closed) await this.show(this.service.snapshot?.() ?? await this.service.poll()); });
            this.tail = work.catch(() => { if (!this.closed) this.view.setStatus(t('harness.disconnected')); });
        }, 50);
    }
    private schedule() {
        this.timer = setTimeout(() => {
            if (this.closed) return;
            if (!this.working) {
                const poll = this.tail.then(async () => { if (!this.closed) await this.show(await this.service.poll()); });
                this.tail = poll.catch(() => { if (!this.closed) this.view.setStatus(t('harness.disconnected')); });
            }
            void this.tail.finally(() => { if (!this.closed) this.schedule(); });
        }, 1000);
    }
    async destroy() { if (this.closed) return; await this.flushPendingSave(); this.closed = true; this.releaseUpdates?.(); clearTimeout(this.updateTimer); clearTimeout(this.timer); await this.service.close(); await this.tail; this.branches?.destroy(); await this.view?.destroy(); this.container.replaceChildren(); }
    getText() { return remoteRounds(this.snapshot?.messages ?? []).map(group => group.content ?? group.executionRoot?.data.output ?? '').join('\n\n'); }
    async navigateTo(target: {elementId: string}): Promise<void> {
        if (!target.elementId.startsWith('native-item:')) return;
        const id = target.elementId.slice('native-item:'.length);
        for (let page = 0; page < 64 && !this.closed; page++) {
            await this.tail;
            if (this.view.history.locate(id, this.snapshot?.messages ?? [])) return;
            if (!this.snapshot?.hasEarlier || this.historyError) break;
            await this.loadHistory();
        }
        throw new Error(t('project.search.navigateFailed'));
    }
    focus() { this.view.input.focus(); }
    isDirty() { return (this.view?.input.getConfig().text ?? '') !== this.savedDraft || this.draftFiles.length !== this.savedFiles.length || this.draftFiles.some((file, index) => file !== this.savedFiles[index]); }
    async flushPendingSave() {
        if (!this.isDirty() || this.closed) return;
        try {
            const files = [...this.draftFiles], text = this.view?.input.getConfig().text ?? '';
            const attachments = await prepareRemoteAttachments(files, this.snapshot?.attachments ?? []);
            if (attachments.length || this.savedFiles.length) await this.service.saveDraft?.(text, attachments);
            else await this.service.saveDraft?.(text);
            this.savedDraft = text; this.savedFiles = files; this.emit('saved', undefined);
        }
        catch (error) { this.emit('saveError', error); throw error; }
    }
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]) { for (const listener of this.events.get(event) ?? []) listener(payload); }
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {
        const listener = (payload: unknown) => callback(payload as EditorEventMap[E]);
        if (!this.events.has(event)) this.events.set(event, new Set());
        this.events.get(event)!.add(listener); return () => { this.events.get(event)?.delete(listener); };
    }
    setReadOnly(value: boolean) { this.options.readOnly = value; this.updateControls(); }
    get commands() { return {sendMessage: (message: {text: string; files?: File[]}) => {
        return this.sendText(message.text, message.files);
    }}; }
}
