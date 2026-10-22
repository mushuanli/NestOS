import {ConversationComposer} from './drafts/conversation-composer';
import type {IChatInputConfig} from '../domain/ports/IChatInputPresenter';
interface SubmittedInput {text: string; files: File[]; revision: number; config: IChatInputConfig}
import { BaseSettingsEditor, Toast, conversationStatus, type ConversationControls, type ConversationSnapshot, type EditorOptions, type EditorEvent, type EditorEventCallback, type EditorEventMap } from '@itookit/ui-common';
import { escapeHTML, randomUUID, t } from '@itookit/common';
import {renderConversationRequests, clearConversationRequests} from './remote-interactions';
import { ConversationWorkspaceView } from './ConversationWorkspaceView';
import { RemoteBranches } from './remote-branches';
import {RemoteHistoryBranches} from './remote-history-branches';
import { remoteRounds, remotePrompts } from './remote-rounds';
import { prepareRemoteAttachments, restoreRemoteAttachments } from './remote-attachments';
import type { ChatSubmission } from '../domain/submission';
import type { WorkspaceHandoff } from './drafts/workspace-handoff';
import {isCommandInput} from '@itookit/llm-ui';
import {resolveNativeCommand, submitNativeCommand} from '../independent/native-command';
import {nativeBranchCommand, withNativeBranchCommands} from '../commands/native-branch-command';

/** Native histories remain remote; this editor only owns a view and input draft. */
export class RemoteConversationEditor extends BaseSettingsEditor<ConversationControls> {
    private view!: ConversationWorkspaceView;
    private branches?: RemoteBranches;
    private historyBranches?: RemoteHistoryBranches;
    private snapshot?: ConversationSnapshot;
    private closed = false;
    private active = true;
    private branchRevision = 0;
    private releaseUpdates?: () => void;
    private updateTimer?: ReturnType<typeof setTimeout>;
    private working = false;
    private loadingHistory = false;
    private historyError = '';
    private findingPrompts = false;
    private tail: Promise<unknown> = Promise.resolve();
    private announced?: string;
    private savedDraft = '';
    private savedConfig = '';
    private composer?: ConversationComposer;
    private restoredDraft = false;
    private draftFiles: File[] = [];
    private savedFiles: File[] = [];
    private submittedDraft?: {text: string; files: File[]; revision: number};
    private submission?: ChatSubmission;
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    private interactionKey = '';
    private renderTail: Promise<unknown> = Promise.resolve();
    private updating = false;
    private updateRequested = false;
    private adoptedInput = false;
    constructor(container: HTMLElement, controls: ConversationControls, options: EditorOptions, private handoff?: WorkspaceHandoff) { super(container, controls, options); }
    async init(container: HTMLElement) {
        this.container = container;
        const abort = () => { void this.service.close().catch(() => {}); };
        this.options.signal?.throwIfAborted();
        this.options.signal?.addEventListener('abort', abort, {once: true});
        try { await this.render(); this.options.signal?.throwIfAborted(); }
        finally { this.options.signal?.removeEventListener('abort', abort); }
    }
    async render() {
        this.composer = ConversationComposer.create(this.service);
        this.layout();
        try { await this.show(await this.service.read()); } catch (error) { this.showError(error); }
        if (!this.closed && this.active) {
            if (this.service.subscribe) this.releaseUpdates = this.service.subscribe(() => this.queueUpdate());
        }
    }
    private layout() {
        this.adoptedInput = !!this.handoff;
        this.view = new ConversationWorkspaceView(this.container, {...this.options,
            onStartConversationDraft: this.options.onStartConversationDraft ? async input => {
                await this.flushPendingSave(); await this.options.onStartConversationDraft!(input);
            } : undefined}, {
            send: (text, files) => this.sendText(text, files),
            flushDraft: () => this.flushPendingSave(),
            persistImageFiles: this.composer ? (files, resize) => this.persistImages(files, resize) : undefined,
            models: this.service.models ? () => this.service.models!() : undefined,
            commands: () => this.readCommands(),
            attachments: this.options.readOnly ? undefined : this.service.snapshot?.().attachments,
            stop: () => { void this.runControl(() => this.service.interrupt()).catch(() => {}); },
            refresh: () => { void this.run(() => this.service.read()).catch(() => {}); },
            reconcile: () => { void this.run(async () => {
                const snapshot = this.composer?.submissionId ? await this.service.reconcile(this.composer.submissionId) : await this.service.reconcile();
                if (!this.composer && this.submission?.state === 'unknown' && !snapshot.pending && !snapshot.submittedTurnId)
                    this.submission = {...this.submission, state: 'failed', error: t('chat.submission.unconfirmed')};
                return snapshot;
            }).catch(() => {}); },
            earlier: () => { this.historyError = ''; void this.loadHistory(); },
            openPrompts: () => { void this.findPrompts(); },
            changed: files => { this.draftFiles = files ?? []; this.emit('interactiveChange', undefined); }, copy: () => this.getText(),
            rename: title => {
                if (title !== this.snapshot?.title && this.snapshot?.canRename && this.service.rename)
                    void this.run(() => this.service.rename!(title)).catch(() => {});
            },
        }, this.handoff); this.handoff = undefined;
        const fork = (action: () => Promise<ConversationSnapshot>) => this.runBranch(action);
        this.branches = new RemoteBranches(this.service, this.options, fork, error => this.showError(error));
        this.container.querySelectorAll('#llm-branch-indicator')[0]!.append(this.branches.element);
        this.historyBranches = new RemoteHistoryBranches(this.container, this.service, this.options, fork, error => {
            if (!this.closed && this.active) {this.showError(error); Toast.error(escapeHTML(error instanceof Error ? error.message : String(error)));}
        });
    }
    private persistImages(files: File[], resize: import('@itookit/image-parser').ImageResizePolicy): Promise<void> {
        const config = this.view.input.getConfig();
        return this.composer!.save({...config, settings: {...config.settings, imageResize: resize}}, files);
    }
    private show(snapshot: ConversationSnapshot): Promise<void> {
        const work = this.renderTail.then(() => this.present(snapshot));
        this.renderTail = work.catch(() => {}); return work;
    }
    private async present(snapshot: ConversationSnapshot) {
        if (this.closed || !this.active) return;
        if (!this.composer && this.snapshot?.pending && !snapshot.pending && snapshot.draft === '' && !snapshot.draftAttachments?.length && this.submittedDraft) {
            await this.acceptSubmission(this.submittedDraft.text, this.submittedDraft.files, this.submittedDraft.revision); this.submittedDraft = undefined;
        }
        this.snapshot = snapshot;
        await this.restoreDraft(snapshot);
        await this.reconcileComposer(snapshot);
        if (!this.composer && this.submission?.state === 'unknown' && !snapshot.pending && snapshot.submittedTurnId) {
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
            renderConversationRequests(this.view.interactions, snapshot.requests, async (id, response) => {await this.runControl(() => this.service.respond(id, response));}, !this.options.readOnly && !!snapshot.canRespond);
        }
        this.view.setTitle(snapshot.title);
        this.view.setSessionTimes(snapshot.createdAt, snapshot.updatedAt);
        this.view.setInformation(snapshot);
        this.showStatus(snapshot);
        this.updateControls();
    }
    private showStatus(snapshot: ConversationSnapshot): void {
        const observation: NonNullable<ConversationSnapshot['observation']> = snapshot.observation ?? {execution: snapshot.requests.some(r => r.kind === 'approval') ? 'waiting-approval'
            : snapshot.requests.some(r => r.kind === 'input') ? 'waiting-input' : snapshot.active || snapshot.canInterrupt ? 'running' : 'unknown',
            updatedAt: snapshot.updatedAt, connection: snapshot.disconnected ? 'offline' : 'online', stale: snapshot.gap, receiptUnknown: snapshot.pending, source: 'history', observedAt: 0};
        const status = conversationStatus(observation, Date.now(), {inferActivity: false});
        const submission = this.submission;
        if (this.composer?.hasSubmission && !submission && !snapshot.pending) {
            this.view.setStatus(t('harness.unknown'), 'queued'); return;
        }
        const attention = [submission && submission.state !== 'accepted', observation.nativeError, observation.refreshError,
            observation.connection === 'offline', observation.stale, observation.receiptUnknown,
            snapshot.pending, snapshot.disconnected, snapshot.gap].some(Boolean);
        this.view.setStatus(submission && submission.state !== 'accepted'
            ? [t(`chat.submission.${submission.state}`), submission.error].filter(Boolean).join(' ') : status.text,
            submission?.state === 'failed' ? 'failed' : submission && submission.state !== 'accepted' ? 'queued' : status.indicator,
            {inline: attention, indicator: attention || status.indicator !== 'idle', tooltip: status.tooltip});
    }
    private async restoreDraft(snapshot: ConversationSnapshot) {
        if (this.restoredDraft) return;
        const restored = await this.composer?.restore();
        if (this.closed) return;
        this.savedDraft = snapshot.draft ?? '';
        if (!this.options.initialInputState?.text && !this.adoptedInput) {
            this.draftFiles = restoreRemoteAttachments(snapshot.draftAttachments ?? []);
            this.view.input.restoreDraft(this.savedDraft, this.draftFiles, this.view.input.getConfig().agentId);
            if (restored?.config) {
                const executor = this.view.input.getConfig().agentId;
                this.view.input.setConfig({...restored.config, agentId: executor});
                this.view.input.restoreDraft(restored.config.text, restored.files, executor);
                this.draftFiles = restored.files; this.savedDraft = restored.config.text;
            }
            this.savedFiles = [...this.draftFiles];
        }
        this.savedConfig = JSON.stringify(this.view.input.getConfig());
        if (!this.composer && snapshot.pending) this.submittedDraft = {text: this.savedDraft, files: [...this.draftFiles], revision: this.view.input.getDraftRevision()};
        this.restoreSubmission(restored?.submission);
        this.restoredDraft = true;
    }
    private async reconcileComposer(snapshot: ConversationSnapshot): Promise<void> {
        const receipt = snapshot.submission;
        if (!this.composer?.submissionId || receipt?.id !== this.composer.submissionId || receipt.status === 'pending') return;
        if (receipt.status === 'accepted' && this.submittedDraft) {
            const draft = this.submittedDraft;
            if (this.submission?.id === receipt.id) this.submission = {...this.submission, state: 'accepted', messageId: this.submittedMessageId(receipt.turnId)};
            await this.acceptSubmission(draft.text, draft.files, draft.revision);
        } else {
            this.composer.accepted();
            if (this.submission?.id === receipt.id) this.submission = {...this.submission, state: 'failed', error: this.sendError({remoteCode: receipt.code}) ?? t('chat.submission.unconfirmed')};
            await this.composer.save(this.view.input.getConfig(), this.draftFiles);
        }
        this.submittedDraft = undefined;
    }
    private updateControls() {
        this.container.querySelectorAll<HTMLButtonElement>('#llm-btn-refresh')[0]!.disabled = this.working || this.loadingHistory;
        this.view.setRenameAvailability(!this.working && !this.options.readOnly && !!this.snapshot?.canRename && !!this.service.rename);
        if (this.snapshot) this.branches?.update(this.snapshot, this.working);
        if (this.snapshot) this.historyBranches?.update(this.snapshot, this.working);
        this.view.earlier.hidden = !this.snapshot?.hasEarlier || !this.service.loadEarlier;
        this.view.earlier.disabled = this.working || this.loadingHistory;
        this.view.setHistoryProgress(this.snapshot?.messages.length ?? 0, !!this.snapshot?.hasEarlier, this.loadingHistory, this.historyError);
        this.view.input.setLoading(!!this.snapshot?.canInterrupt);
        this.view.input.setAvailability({
            canSend: this.restoredDraft && !this.composer?.hasSubmission && !this.working && this.submission?.state !== 'unknown' && !this.options.readOnly && !!this.snapshot?.canSend,
            canInterrupt: !this.working && !this.options.readOnly && !!this.snapshot?.canInterrupt,
        });
        this.view.input.setNativeModelsAvailable(!!this.snapshot?.supportsModels && !this.options.readOnly);
        this.showComposerConflict();
        this.view.reconcile.disabled = this.working || !this.snapshot?.pending && this.submission?.state !== 'unknown' && !this.composer?.hasSubmission;
        if (this.snapshot) renderConversationRequests(this.view.interactions, this.snapshot.requests, async (id, response) => {await this.runControl(() => this.service.respond(id, response));}, !this.options.readOnly && !!this.snapshot.canRespond);
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
    private async findPrompts(): Promise<void> {
        if (this.findingPrompts || this.historyError) return;
        this.findingPrompts = true;
        try {
            for (let page = 0; page < 3; page++) {
                if (!this.needsPromptHistory()) break;
                const before = this.snapshot;
                await this.loadHistory();
                if (this.historyError || this.snapshot === before) break;
            }
        } finally { this.findingPrompts = false; }
    }
    private needsPromptHistory(): boolean {
        return !this.closed && !this.working && !!this.snapshot?.hasEarlier && !!this.service.loadEarlier
            && remotePrompts(this.snapshot.messages).length === 0;
    }
    async sendText(text: string, files: File[] = [], nativeSelection?: import('@itookit/ui-common').ConversationModelSelection): Promise<void> {
        if (!text.trim() && !files.length) return;
        const command = nativeBranchCommand(text);
        if (command) {
            await this.sendBranchCommand(command, text, files); return;
        }
        if (this.closed || this.working || this.submission?.state === 'unknown' || this.composer?.hasSubmission || this.options.readOnly || !this.snapshot?.canSend) throw new Error(t('harness.remoteBusy'));
        const selection = nativeSelection ? {...nativeSelection} : this.view.input.getNativeModelSelection();
        const revision = this.view.input.getDraftRevision(), currentText = this.view.input.getConfig().text;
        if (isCommandInput(text) && this.snapshot?.supportsSlashCommands && this.service.command && this.service.commands) {
            await this.sendCommand(currentText.trim() === text.trim() ? currentText : text, files, selection, revision); return;
        }
        const input: SubmittedInput = {text, files: [...files], revision, config: {...this.view.input.getConfig(), text}};
        this.submission = {id: randomUUID(), text: text.trim() || t('harness.attachmentPrompt'), timestamp: Date.now(), state: 'submitting'};
        const frozen = this.composer?.submit(input.config, input.files, this.submission.id); void frozen?.catch(() => {});
        await this.run(() => this.sendInput(input, selection, frozen));
        if (this.submission?.state === 'unknown' || this.composer?.hasSubmission) throw new Error(t('chat.submission.unknown'));
        if (this.submission?.state === 'failed') throw new Error(t('chat.submission.unconfirmed'));
    }
    private async sendBranchCommand(command: {name: string; arguments: string}, text: string, files: File[]): Promise<void> {
        try {
            if (files.length) throw new Error(t('harness.commandUnavailable'));
            if (this.closed || !this.active || this.options.readOnly || this.working || this.composer?.hasSubmission) throw new Error(t('branch.unavailable'));
            const revision = this.view.input.getDraftRevision(), draft = this.view.input.getConfig().text;
            const accepted = () => this.acceptSubmission(draft.trim() === text.trim() ? draft : text, [], revision);
            if (command.name === 'branch') await this.branches!.createLatest(command.arguments, accepted);
            else {if (command.arguments.trim()) throw new Error(t('harness.commandUnavailable')); await this.branches!.open(); await accepted();}
        } catch (error) {if (!this.closed) this.showError(error); throw error;}
    }
    private async runBranch(action: () => Promise<ConversationSnapshot>): Promise<void> {
        const revision = this.branchRevision, sessionId = this.snapshot?.sessionId;
        const available = () => !this.closed && this.active && !this.options.readOnly
            && revision === this.branchRevision && sessionId === this.snapshot?.sessionId && !!this.snapshot?.canFork;
        if (!available()) throw new Error(t('branch.unavailable'));
        await this.run(async () => {
            await this.flushPendingSave();
            if (!available()) throw new Error(t('branch.unavailable'));
            return action();
        });
    }
    private async readCommands(): Promise<import('@itookit/ui-common').ConversationSlashCommand[]> {
        return withNativeBranchCommands(await this.service.commands?.() ?? []);
    }
    private async sendInput(input: SubmittedInput, selection: import('@itookit/ui-common').ConversationModelSelection | undefined, frozen?: Promise<string>): Promise<ConversationSnapshot> {
        let ready = false, invoked = false;
        try {
            this.view.history.view.setSubmission(this.submission); this.view.history.view.scrollToBottom(true);
            this.view.setStatus(t('chat.submission.submitting'), 'queued');
            await frozen; ready = !!this.composer;
            const attachments = await prepareRemoteAttachments(input.files, this.snapshot?.attachments ?? []);
            if (this.composer) {this.savedDraft = input.text; this.savedFiles = input.files; this.savedConfig = JSON.stringify(input.config);}
            this.submittedDraft = {text: input.text, files: input.files, revision: input.revision};
            invoked = true; const result = await this.sendPrepared(input.text, attachments, selection);
            const accepted = this.composer ? result.submission?.id === this.composer.submissionId && result.submission?.status === 'accepted'
                : !!result.submittedTurnId || !result.pending;
            this.submission = {...this.submission!, state: accepted ? 'accepted' : 'unknown', messageId: this.submittedMessageId(result.submittedTurnId)};
            if (!this.closed && accepted) {await this.acceptSubmission(input.text, input.files, input.revision); this.submittedDraft = undefined;}
            return result;
        } catch (error) {return this.submissionFailure(error, ready && !invoked);}
    }
    private sendPrepared(text: string, attachments: NonNullable<Parameters<ConversationControls['send']>[1]>, selection?: import('@itookit/ui-common').ConversationModelSelection) {
        if (this.composer) return this.service.send(text.trim() || t('harness.attachmentPrompt'), attachments, selection, this.composer.submissionId);
        return selection ? this.service.send(text.trim() || t('harness.attachmentPrompt'), attachments, selection)
            : attachments.length ? this.service.send(text.trim() || t('harness.attachmentPrompt'), attachments) : this.service.send(text);
    }
    private async submissionFailure(error: unknown, beforeSend: boolean): Promise<ConversationSnapshot> {
        if (beforeSend && this.composer) {this.composer.accepted(); await this.composer.save(this.view.input.getConfig(), this.draftFiles).catch(failure => this.emit('saveError', failure));}
        await this.releaseRejectedSubmission(error);
        this.submission = {...this.submission!, state: this.composer?.hasSubmission || this.service.snapshot?.().pending || (error as {outcome?: string})?.outcome === 'unknown' ? 'unknown' : 'failed',
            error: this.sendError(error)};
        const recovered = await this.recoverSubmission();
        if (recovered?.submission?.status === 'accepted') return recovered;
        if (!this.closed) {this.view.history.view.setSubmission(this.submission); this.showError(error);}
        throw error;
    }
    private async recoverSubmission(): Promise<ConversationSnapshot | undefined> {
        const id = this.composer?.submissionId;
        if (!id || this.submission && this.submission.state !== 'unknown' || this.closed) return;
        try {
            // Query the exact receipt once; never replay the failed send.
            const snapshot = await this.service.reconcile(id);
            if (snapshot.submission?.id !== id || snapshot.submission.status === 'pending') return;
            await this.show(snapshot); return snapshot;
        } catch { /* Keep the frozen submission until a later explicit receipt query succeeds. */ }
    }
    private submittedMessageId(turnId?: string): string | undefined {
        return turnId ? remoteRounds([{id: 'ack', role: 'user', text: '', turnId}])[0]?.id : undefined;
    }
    private async sendCommand(text: string, files: File[], selection: import('@itookit/ui-common').ConversationModelSelection | undefined, revision: number): Promise<void> {
        if (files.length) throw new Error(t('harness.commandUnavailable'));
        const frozen = this.composer?.submit({...this.view.input.getConfig(), text}, [], randomUUID(), 'command'); void frozen?.catch(() => {});
        let ready = false, invoked = false;
        try {
            const id = await frozen; ready = !!this.composer;
            const resolved = resolveNativeCommand(text, await this.service.commands!());
            if (!resolved) throw new Error(t('harness.commandUnavailable'));
            if (this.closed || this.working || this.options.readOnly || !this.snapshot?.canSend) throw new Error(t('harness.remoteBusy'));
            this.submittedDraft = {text, files: [], revision};
            await this.run(async () => {
                invoked = true;
                const snapshot = await submitNativeCommand(this.service, resolved.command, resolved.arguments, text, selection, id);
                if (id && snapshot.submission?.id === id && snapshot.submission.status === 'rejected')
                    throw Object.assign(new Error(t('chat.submission.unconfirmed')), {outcome: 'not-committed'});
                if (!this.composer && !snapshot.pending && !this.closed) {await this.acceptSubmission(text, [], revision); this.submittedDraft = undefined;}
                return snapshot;
            });
        } catch (error) {
            if (ready && !invoked && this.composer) {this.composer.accepted(); await this.composer.save(this.view.input.getConfig(), this.draftFiles).catch(failure => this.emit('saveError', failure));}
            await this.releaseRejectedSubmission(error);
            if ((await this.recoverSubmission())?.submission?.status === 'accepted') return;
            throw error;
        }
        if (this.snapshot?.pending || this.composer?.hasSubmission) throw new Error(t('chat.submission.unknown'));
    }
    private sendError(error: unknown): string | undefined {
        const code = (error as {remoteCode?: string})?.remoteCode;
        return code === 'HARNESS_SESSION_BUSY' || error instanceof Error && error.message.includes('HARNESS_SESSION_BUSY')
            ? t('chat.submission.occupied') : error instanceof Error ? error.message : undefined;
    }
    private async acceptSubmission(text: string, files: File[], revision: number) {
        this.view.input.acceptSubmittedDraft(text, files, revision);
        this.draftFiles = this.draftFiles.filter(file => !files.includes(file)); this.savedFiles = [];
        this.savedDraft = '';
        this.composer?.accepted();
        if (this.composer) {try {await this.flushPendingSave(true);} catch (error) {this.emit('saveError', error);}}
        this.emit(this.isDirty() ? 'interactiveChange' : 'saved', undefined);
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
    private async releaseRejectedSubmission(error: unknown): Promise<void> {
        const failure = error as {code?: string; remoteCode?: string; outcome?: string};
        const definite = failure?.outcome === 'not-committed' || failure?.outcome !== 'unknown'
            && ['EINVAL', 'ECAPABILITY', 'EACCES', 'EBUSY', 'ECONFLICT'].includes(failure?.code ?? failure?.remoteCode ?? '');
        if (!definite || !this.composer?.hasSubmission) return;
        this.composer.accepted(); this.submittedDraft = undefined;
        await this.composer.save(this.view.input.getConfig(), this.draftFiles).catch(saveError => this.emit('saveError', saveError));
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
            this.view.setStatus([t(`chat.submission.${this.submission.state}`), this.submission.error].filter(Boolean).join(' '), this.submission.state === 'failed' ? 'failed' : 'queued');
        } else this.view.setStatus(this.snapshot?.pending ? t('harness.unknown') : `${t('harness.failed')} ${error instanceof Error ? error.message : ''}`, this.snapshot?.pending ? 'queued' : 'failed');
        this.showComposerConflict();
    }
    private showComposerConflict(): void {
        if (!this.composer?.conflicted || this.view.status.querySelector('[data-reload-composer]')) return;
        const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = t('chat.draft.reload'); reload.dataset.reloadComposer = '';
        reload.onclick = () => {void this.reloadComposer().catch(failure => this.showError(failure));}; this.view.status.append(reload);
    }
    private restoreSubmission(pending: Awaited<ReturnType<ConversationComposer['restore']>>['submission']): void {
        if (!pending) return;
        this.submittedDraft = {text: pending.text, files: pending.files, revision: pending.clearText ? this.view.input.getDraftRevision() : -1};
        this.submission = pending.kind === 'command' ? undefined : {id: this.composer!.submissionId ?? randomUUID(), text: pending.text, timestamp: Date.now(), state: 'unknown'};
    }
    private async reloadComposer(): Promise<void> {
        if (!this.composer || this.working || this.closed) return;
        const restored = await this.composer.restore(); if (this.closed || !restored.config) return;
        const input = this.view.input, executor = input.getConfig().agentId;
        input.acceptSubmittedDraft(input.getConfig().text, this.draftFiles, input.getDraftRevision());
        input.setConfig({...restored.config, agentId: executor}); input.restoreDraft(restored.config.text, restored.files, executor);
        this.draftFiles = restored.files; this.savedFiles = [...restored.files]; this.savedDraft = restored.config.text;
        this.savedConfig = JSON.stringify(input.getConfig()); this.submittedDraft = undefined; this.submission = undefined;
        this.restoreSubmission(restored.submission);
        if (this.snapshot) await this.show(this.snapshot); this.emit('saved', undefined);
    }
    private queueUpdate(): void {
        if (this.closed || !this.active) return;
        this.updateRequested = true;
        if (this.updateTimer || this.updating) return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            if (this.closed || !this.active) return;
            this.updateRequested = false; this.updating = true;
            void this.showUpdate().finally(() => {this.updating = false; if (this.updateRequested) this.queueUpdate();});
        }, 50);
    }
    private async showUpdate(): Promise<void> {
        try {await this.show(this.service.snapshot?.() ?? await this.service.refresh());}
        catch (error) {this.showUpdateError(error);}
    }
    private async runControl(action: () => Promise<ConversationSnapshot>): Promise<void> {
        if (this.closed || this.options.readOnly) return;
        try {await this.show(await action());}
        catch (error) {if (!this.closed) this.showError(error); throw error;}
    }
    private showUpdateError(error: unknown): void {
        if (this.closed || !this.active) return;
        console.error('[Conversation] Update failed', error);
        const message = error instanceof Error ? error.message : t('harness.failed');
        this.view.setStatus(t('harness.updateFailed', {message}));
    }
    async destroy(preserveInput = false) { if (this.closed) return; this.cancelPendingRender(); await this.flushPendingSave(); this.closed = true; this.historyBranches?.destroy(); this.releaseUpdates?.(); clearTimeout(this.updateTimer); clearConversationRequests(this.view.interactions); await this.service.close(); await this.tail; await this.renderTail; this.branches?.destroy(); await this.view?.destroy(preserveInput); if (!preserveInput) this.container.replaceChildren(); }
    cancelPendingRender(): void {
        ++this.branchRevision;
        this.historyBranches?.setActive(false);
        this.view?.input.hideNativeModelPicker();
        this.view?.history.view.setActive(false);
        this.active = false; this.releaseUpdates?.(); this.releaseUpdates = undefined;
        clearTimeout(this.updateTimer); this.updateTimer = undefined;
    }
    async activate(): Promise<void> {
        if (this.closed || this.active) return;
        this.historyBranches?.setActive(true);
        this.view?.history.view.setActive(true);
        this.active = true; await this.tail; await this.show(await this.service.read());
        if (!this.active || this.closed) return;
        if (this.service.subscribe) this.releaseUpdates = this.service.subscribe(() => this.queueUpdate());
    }
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
    isDirty() { return (this.composer && JSON.stringify(this.view?.input.getConfig()) !== this.savedConfig) || (this.view?.input.getConfig().text ?? '') !== this.savedDraft || this.draftFiles.length !== this.savedFiles.length || this.draftFiles.some((file, index) => file !== this.savedFiles[index]); }
    async flushPendingSave(force = false) {
        if (!force && !this.isDirty() || this.closed) return;
        try {
            const files = [...this.draftFiles], config = this.view.input.getConfig(), text = config.text;
            if (this.composer) {
                await this.composer.save(config, files);
                this.savedDraft = text; this.savedFiles = files; this.savedConfig = JSON.stringify(config); this.emit('saved', undefined); return;
            }
            const attachments = await prepareRemoteAttachments(files, this.snapshot?.attachments ?? []);
            if (attachments.length || this.savedFiles.length) await this.service.saveDraft?.(text, attachments);
            else await this.service.saveDraft?.(text);
            this.savedDraft = text; this.savedFiles = files; this.emit('saved', undefined);
        }
        catch (error) { this.emit('saveError', error); this.showError(error); throw error; }
    }
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]) { for (const listener of this.events.get(event) ?? []) listener(payload); }
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {
        const listener = (payload: unknown) => callback(payload as EditorEventMap[E]);
        if (!this.events.has(event)) this.events.set(event, new Set());
        this.events.get(event)!.add(listener); return () => { this.events.get(event)?.delete(listener); };
    }
    setReadOnly(value: boolean) { if (value !== !!this.options.readOnly) ++this.branchRevision; this.options.readOnly = value; this.updateControls(); }
    get commands() { return {sendMessage: (message: {text: string; files?: File[]; nativeSelection?: import('@itookit/ui-common').ConversationModelSelection}) => {
        return this.sendText(message.text, message.files, message.nativeSelection);
    }}; }
}
