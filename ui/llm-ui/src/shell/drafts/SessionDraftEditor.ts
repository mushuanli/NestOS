import { DraftSaveQueue } from './draft-save-queue';
import { DraftExecutionPicker } from './DraftExecutionPicker';
import { LayoutTemplates } from '../../components/templates/LayoutTemplates';
import { DraftDataCodec } from './session-draft-data';
import type { IChatInputConfig } from '../../domain/ports/IChatInputPresenter';
import { IEditor, Toast, type EditorOptions, type OcrControls } from '@itookit/ui-common';
import { t } from '@itookit/common';
import { ChatInput } from '../../components/input/ChatInputView';
import { EventBinder } from '../EventBinder';
import { buildExecutorOptions, buildConnectionOptions } from '../AgentProvider';
import type { SendMessageParams } from '../../commands/SendMessageCommand';
import {SubmissionFeedback} from '../../components/history/SubmissionFeedback';

/** Reuse the chat composer while persisting project drafts independently from Session history. */
export class SessionDraftEditor extends IEditor {
    private codec: DraftDataCodec;
    private input?: ChatInput;
    private targets?: DraftExecutionPicker;
    private closed = false;
    private active = true;
    private sending = false;
    private restoring = true;
    private readonly saves = new DraftSaveQueue(data => this.options.sessionDraft?.save?.(data) ?? Promise.resolve(), error => {
        if (this.closed || !this.status) return;
        this.status.hidden = !error;
        if (error) this.status.textContent = t('project.draftSaveFailed');
    });
    private config?: IChatInputConfig;
    private initialData?: string;
    private unsubscribeConnections?: () => void;
    private status?: HTMLElement;
    private submission?: SubmissionFeedback;
    private editRevision = 0;
    private refreshing?: Promise<void>;
    private events?: EventBinder;
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
        this.input = this.createInput(input, agents, saved.config);
        this.unsubscribeConnections?.();
        this.unsubscribeConnections = this.service.onChange(() => { void this.input?.refreshConnections(); });
        if (saved.config) this.input.restoreDraft(saved.config.text, saved.files, saved.config.agentId);
        if (agents.length) this.targets = new DraftExecutionPicker(input, this.input, agents, this.options.hostContext?.navigate
            ? () => { void this.openFlows().catch(error => Toast.error(String(error))); } : undefined);
        this.restoring = false;
        if (saved.migrated && saved.config) { this.persist(saved.config, saved.files); await this.saves.flush(); }
        window.addEventListener('beforeunload', this.beforeUnload);
        if (this.active) this.input.focus();
    }
    private createInput(input: HTMLElement, agents: Awaited<ReturnType<typeof buildExecutorOptions>>, config?: IChatInputConfig): ChatInput {
        return new ChatInput(input, { initialAgents: agents, ocr: this.ocr, initialConfig: config, executorUsage: this.options.executorUsage,
            onConfigureExecutor: this.options.hostContext?.navigate ? () => {
                const id = this.input!.getConfig().agentId;
                void this.options.hostContext!.navigate({target: 'agents', resourceId: this.service.getAgentResourceId?.(id)});
            } : undefined,
            onDraftChange: (config, files) => { if (!this.restoring && !this.sending) this.persist(config, files); },
            onRequestConnections: () => buildConnectionOptions(this.service), onStop: () => {},
            onSend: (text, files, agentId, overrides) => this.send({ text, files, agentId, overrides }),
            onNavigateSettings: ({resourceId, anchor}) => { void this.options.hostContext?.navigate?.({ target: 'settings', resourceId, ...(anchor ? {state: {anchor}} : {}) }); },
        });
    }
    private initLayout(): void {
        this.events?.cleanup();
        this.container.classList.add('llm-ui-workspace');
        this.container.innerHTML = LayoutTemplates.renderWorkspace(t('project.createSession'));
        const title = this.container.querySelector<HTMLInputElement>('#llm-title-input')!;
        title.readOnly = true;
        this.status = this.container.querySelector<HTMLElement>('#llm-status-indicator')!;
        this.status.setAttribute('role', 'status'); this.status.hidden = true;
        this.container.querySelector<HTMLElement>('#llm-ui-history')!.innerHTML = LayoutTemplates.renderWelcome();
        this.submission = new SubmissionFeedback(this.container.querySelector<HTMLElement>('#llm-ui-history')!, {htmlPolicy: 'literal'});
        this.container.querySelector<HTMLButtonElement>('#llm-btn-sidebar')!.hidden = !this.options.hostContext?.toggleSidebar;
        for (const id of ['llm-btn-prompt-nav', 'llm-btn-collapse']) this.container.querySelector<HTMLElement>('#' + id)!.hidden = true;
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
        this.events = new EventBinder(this.container, {mountCompactNavigation: this.options.mountCompactNavigation,
            onToggleSidebar: () => this.options.hostContext?.toggleSidebar()});
        this.events.bindTitleBarEvents();
    }
    private persist(config: IChatInputConfig, files: File[]): void {
        ++this.editRevision;
        this.config = structuredClone(config);
        if (!this.options.sessionDraft?.save) return;
        this.status!.hidden = true;
        this.saves.save(this.codec.encode(config, files));
    }
    private async openFlows(): Promise<void> {
        if (this.closed || this.sending) return;
        await this.saves.flush();
        if (!this.closed) await this.options.hostContext?.navigate({target: 'flows'});
    }
    private async send(message: SendMessageParams): Promise<void | false> {
        if (this.closed || this.sending || (!message.text.trim() && !message.files.length)) return;
        if (this.config) this.persist({ ...this.config, text: message.text, agentId: message.agentId ?? 'default' }, message.files);
        this.sending = true; this.input!.setLoading(true); this.targets?.setLoading(true);
        const feedback = {id: crypto.randomUUID(), text: message.text || t('harness.attachmentPrompt'), timestamp: Date.now(), state: 'submitting' as const};
        this.container.querySelector('.llm-ui-welcome')?.remove(); this.submission?.show(feedback);
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
            if (await editor.commands.sendMessage(submission ? { ...message, submission } : message) === false) return false;
        } catch (error) {
            if (!this.closed) this.submission?.show({...feedback, state: 'failed', error: error instanceof Error ? error.message : String(error)});
            if (!this.closed) this.input?.restoreDraft(message.text, message.files, message.agentId ?? 'default');
            Toast.error(error instanceof Error ? error.message : String(error));
            if (message.agentId?.startsWith('remote:')) throw error;
            return false;
        } finally { this.sending = false; if (!this.closed) { this.input?.setLoading(false); this.targets?.setLoading(false); } }
    }
    private async discard(): Promise<void> {
        if (this.sending) return;
        await this.saves.flush();
        await this.options.sessionDraft?.clear?.();
        await this.submission?.destroy();
        this.targets?.destroy(); this.input?.destroy();
        this.initialData = '';
        this.codec = new DraftDataCodec(this.options.sessionDraft?.attachments);
        this.restoring = true;
        await this.render();
    }
    readonly commands = {refreshDraft: () => this.refreshDraft(), appendDraft: async (input: {text: string; files: File[]}) => {
        if (this.closed || this.sending) throw new Error(t('chatInput.switchUnavailable'));
        this.input?.appendDraft(input); await this.saves.flush();
    }};
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
    private refreshDraft(): Promise<void> {
        return this.refreshing ??= Promise.resolve().then(() => this.refreshDraftNow())
            .finally(() => {this.refreshing = undefined;});
    }
    private async refreshDraftNow(): Promise<void> {
        if (this.closed || !this.active || this.sending || this.saves.dirty) return;
        const revision = this.editRevision, controls = this.options.sessionDraft;
        const next = await controls?.refresh?.();
        if (!next || this.closed || !this.active || this.sending || this.saves.dirty || revision !== this.editRevision || controls !== this.options.sessionDraft) return;
        this.targets?.destroy(); this.input?.destroy(); await this.submission?.destroy();
        this.options.sessionDraft = next; this.initialData = next.initialData;
        this.codec = new DraftDataCodec(next.attachments); this.restoring = true;
        await this.render();
    }
    cancelPendingRender(): void {this.active = false;}
    async activate(): Promise<void> { this.active = true; await this.refreshDraft(); await this.input?.refreshConnections(); }
    async destroy(): Promise<void> {
        await this.saves.flush();
        await this.submission?.destroy();
        this.closed = true; this.unsubscribeConnections?.(); window.removeEventListener('beforeunload', this.beforeUnload);
        this.events?.cleanup(); this.targets?.destroy(); this.input?.destroy(); this.container.replaceChildren();
    }
}
