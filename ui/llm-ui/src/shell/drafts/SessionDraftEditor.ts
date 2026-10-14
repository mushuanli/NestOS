import { DraftSaveQueue } from './draft-save-queue';
import { LayoutTemplates } from '../../components/templates/LayoutTemplates';
import { DraftDataCodec } from './session-draft-data';
import type { IChatInputConfig } from '../../domain/ports/IChatInputPresenter';
import { IEditor, Toast, type EditorOptions, type OcrControls } from '@itookit/ui-common';
import { t } from '@itookit/common';
import { ChatInput } from '../../components/input/ChatInputView';
import { buildExecutorOptions, buildConnectionOptions } from '../AgentProvider';
import type { SendMessageParams } from '../../commands/SendMessageCommand';

/** Reuse the chat composer while persisting project drafts independently from Session history. */
export class SessionDraftEditor extends IEditor {
    private codec: DraftDataCodec;
    private input?: ChatInput;
    private closed = false;
    private sending = false;
    private restoring = true;
    private readonly saves = new DraftSaveQueue(data => this.options.sessionDraft?.save?.(data) ?? Promise.resolve(), error => {
        if (this.closed || !this.status) return;
        this.status.hidden = !error;
        if (error) this.status.textContent = t('project.draftSaveFailed');
    });
    private config?: IChatInputConfig;
    private initialData?: string;
    private status?: HTMLElement;
    private readonly beforeUnload = (event: BeforeUnloadEvent) => {
        if (!this.saves.dirty) return;
        event.preventDefault(); event.returnValue = '';
    };
    constructor(private container: HTMLElement, private service: Parameters<typeof buildExecutorOptions>[0], private options: EditorOptions<import('@itookit/llm-flow/contracts').SessionSubmission>,
        private readonly ocr?: OcrControls) { super(); this.initialData = options.sessionDraft?.initialData; this.codec = new DraftDataCodec(options.sessionDraft?.attachments); }
    async init(container: HTMLElement): Promise<void> { this.container = container; await this.render(); }
    async render(): Promise<void> {
        const saved = await this.codec.decode(this.initialData);
        this.config = saved.config;
        const agents = await buildExecutorOptions(this.service, this.options.remoteAgents);
        this.options.signal?.throwIfAborted(); if (this.closed) return;
        this.initLayout();
        const input = this.container.querySelector<HTMLElement>('#llm-ui-input')!;
        this.input = new ChatInput(input, { initialAgents: agents, ocr: this.ocr, initialConfig: saved.config,
            onDraftChange: (config, files) => { if (!this.restoring && !this.sending) this.persist(config, files); },
            onRequestConnections: () => buildConnectionOptions(this.service), onStop: () => {},
            onSend: (text, files, agentId, overrides) => this.send({ text, files, agentId, overrides }),
            onNavigateSettings: target => { void this.options.hostContext?.navigate?.({ target: 'settings', ...target }); },
        });
        if (saved.config) this.input.restoreDraft(saved.config.text, saved.files, saved.config.agentId);
        this.restoring = false;
        if (saved.migrated && saved.config) { this.persist(saved.config, saved.files); await this.saves.flush(); }
        window.addEventListener('beforeunload', this.beforeUnload);
        this.input.focus();
    }
    private initLayout(): void {
        this.container.classList.add('llm-ui-workspace');
        this.container.innerHTML = LayoutTemplates.renderWorkspace(t('project.createSession'));
        const title = this.container.querySelector<HTMLInputElement>('#llm-title-input')!;
        title.readOnly = true;
        this.status = this.container.querySelector<HTMLElement>('#llm-status-indicator')!;
        this.status.setAttribute('role', 'status'); this.status.hidden = true;
        this.container.querySelector<HTMLElement>('#llm-ui-history')!.innerHTML = LayoutTemplates.renderWelcome();
        this.container.querySelector<HTMLButtonElement>('#llm-btn-sidebar')!.onclick = () => this.options.hostContext?.toggleSidebar();
        for (const prompt of this.container.querySelectorAll<HTMLButtonElement>('.llm-ui-welcome__prompt')) {
            prompt.onclick = () => {
                if (!this.input) return;
                const text = [this.input.getConfig().text, prompt.dataset.prompt].filter(Boolean).join('\n');
                this.input.restoreInput(text);
                const textarea = this.container.querySelector<HTMLTextAreaElement>('textarea');
                textarea?.dispatchEvent(new Event('input', { bubbles: true }));
            };
        }
        const actions = this.container.querySelector<HTMLElement>('.llm-workspace-titlebar__menu-actions')!;
        const discard = document.createElement('button'); discard.type = 'button';
        discard.className = 'llm-workspace-titlebar__btn llm-workspace-titlebar__btn--text';
        discard.textContent = t('project.draftDiscard');
        discard.onclick = () => { void this.discard().catch(error => Toast.error(String(error))); };
        actions.replaceChildren(discard);
    }
    private persist(config: IChatInputConfig, files: File[]): void {
        this.config = structuredClone(config);
        if (!this.options.sessionDraft?.save) return;
        this.status!.hidden = true;
        this.saves.save(this.codec.encode(config, files));
    }
    private async send(message: SendMessageParams): Promise<void> {
        if (this.closed || this.sending || (!message.text.trim() && !message.files.length)) return;
        if (this.config) this.persist({ ...this.config, text: message.text, agentId: message.agentId ?? 'default' }, message.files);
        this.sending = true; this.input!.setLoading(true);
        try {
            await this.saves.flush();
            if (message.agentId?.startsWith('remote:')) {
                if (message.files.length) throw new Error(t('harness.remoteAttachments'));
                if (!this.options.remoteAgents) throw new Error(t('toolbox.unavailable'));
                await this.options.remoteAgents.send(message.agentId, message.text);
                await this.options.sessionDraft?.clear?.();
                if (!this.closed) this.input?.restoreDraft('', [], message.agentId);
                return;
            }
            const target = await this.options.sessionDraft!.materialize();
            const editor = target.editor;
            if (!editor.commands.sendMessage) throw new Error('Chat editor cannot send messages');
            if (target.resumeOnly) {
                Toast.info(t('project.draftResume')); return;
            }
            const submission = target.submission;
            await editor.commands.sendMessage(submission ? { ...message, submission } : message);
        } catch (error) {
            if (!this.closed) this.input?.restoreDraft(message.text, message.files, message.agentId ?? 'default');
            Toast.error(error instanceof Error ? error.message : String(error));
            if (message.agentId?.startsWith('remote:')) throw error;
        } finally { this.sending = false; if (!this.closed) this.input?.setLoading(false); }
    }
    private async discard(): Promise<void> {
        if (this.sending) return;
        await this.saves.flush();
        await this.options.sessionDraft?.clear?.();
        this.input?.destroy();
        this.initialData = '';
        this.codec = new DraftDataCodec(this.options.sessionDraft?.attachments);
        this.restoring = true;
        await this.render();
    }
    readonly commands = {};
    getText(): string { return this.input?.getConfig().text ?? this.config?.text ?? ''; }
    setText(text: string): void {
        this.input?.setConfig({ text });
        this.container.querySelector('textarea')?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    getMode(): 'edit' { return 'edit'; }
    async switchToMode(): Promise<void> {}
    setTitle(title: string): void { const input = this.container.querySelector<HTMLInputElement>('#llm-title-input'); if (input) input.value = title; }
    setReadOnly(readOnly: boolean): void { this.input?.setLoading(readOnly); }
    isDirty(): boolean { return this.saves.dirty; }
    setDirty(): void {}
    async navigateTo(): Promise<void> {}
    async search(): Promise<[]> { return []; }
    gotoMatch(): void {}
    clearSearch(): void {}
    on(): () => void { return () => {}; }
    focus(): void { this.input?.focus(); }
    async flushPendingSave(): Promise<void> { await this.saves.flush(); }
    async destroy(): Promise<void> {
        await this.saves.flush();
        this.closed = true; window.removeEventListener('beforeunload', this.beforeUnload);
        this.input?.destroy(); this.container.replaceChildren();
    }
}
