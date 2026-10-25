// @file: llm-ui/commands/SendMessageCommand.ts


import { SessionCommand, type SessionOrigin, type HistoryPolicy } from '@itookit/llm-session/contracts';
import { Command } from './Command';
import { dispatchDirectCommand } from './direct-command';
import { randomUUID, t } from '@itookit/common';
import type { ChatSubmission } from '../domain/submission';
import { Toast } from '@itookit/ui-common';
import { ErrorHandler } from '../utils/errorHandler';
import type { ChatOverrides } from '../domain/types';
import type {PreparedAttachmentUpload} from '../services/AssetService';

import { createAgentSendIntent } from '@itookit/llm-flow/contracts';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import {canonicalSubmission, reconcileSessionCall, submitSessionCall} from './submit-session-call';
import {sameTargetRef} from '@itookit/llm-flow/contracts';
import {sameInputDraft} from '../domain/input-draft';
import type {IChatInputConfig} from '../domain/ports/IChatInputPresenter';
import {validateComposerFiles} from '../flows/composer-file-bindings';

export interface SendMessageParams {
    expectedBranch?: string;
    target?: import('@itookit/llm-flow/contracts').TargetRef;
    text: string;
    files: File[];
    agentId?: string;
    overrides?: ChatOverrides;
    origin?: SessionOrigin;
    historyPolicy?: HistoryPolicy;
    submission?: import('@itookit/llm-flow/contracts').SendIntent['submission'];
}

interface PendingSend {
    sessionId: string; key: string; files: File[]; id: string;
    submission?: SubmissionRequest['submission']; finalText?: string;
    attachments?: PreparedAttachmentUpload['files'];
}
interface ActiveSend {
    input: SendMessageParams & {overrides: ChatOverrides}; pending: PendingSend;
    feedback: ChatSubmission; restore(): void;
}
interface PreparedSend {text: string; submission: NonNullable<SubmissionRequest['submission']>; attachments: PreparedAttachmentUpload['files'];}

export class SendMessageCommand extends Command<SendMessageParams, boolean> {
    protected name = 'Send Message';
    private pending?: PendingSend;

    async reconcile(operationId: string, isCurrent: () => boolean = () => true): Promise<void> {
        const input = this.ctx.chatInput, config = structuredClone(input.getConfig()), revision = input.getDraftRevision?.();
        const saved = structuredClone(this.ctx.operations?.getSnapshot().find(record => record.context.operationId === operationId)?.input) as {request?: SubmissionRequest};
        const request = saved?.request;
        const receipt = await reconcileSessionCall(this.ctx, operationId);
        if (isCurrent() && receipt.status === 'accepted' && request && revision !== undefined) this.consumeReconciledInput(request, config, revision);
    }

    private consumeReconciledInput(request: SubmissionRequest, config: IChatInputConfig, revision: number): void {
        const input = this.ctx.chatInput, current = input.getConfig();
        if (!this.matchesReconciledDraft(request, config, current, revision)) return;
        const text = request.source.kind === 'composer' ? request.source.text : request.presentation?.text ?? '';
        if (config.text.trim() !== text.trim() || current.text !== config.text) return;
        if (!this.consumeReconciledArguments(request, config, current)) return;
        input.acceptSubmittedDraft?.(text, [], revision);
    }

    private matchesReconciledDraft(request: SubmissionRequest, config: IChatInputConfig, current: IChatInputConfig,
        revision: number): boolean {
        const input = this.ctx.chatInput;
        if (!input.acceptSubmittedDraft || !input.getDraftFiles || !this.reconciliationScope(request)) return false;
        if (request.attachments?.length || input.getDraftFiles().length) return false;
        return sameTargetRef(request.expectedTarget, config.target) && sameTargetRef(current.target, config.target)
            && input.getDraftRevision?.() === revision;
    }

    private reconciliationScope(request: SubmissionRequest): boolean {
        return request.expectedSessionId === this.ctx.getSessionId() && !!request.expectedBranch && request.expectedBranch === this.ctx.getBranch?.();
    }

    private consumeReconciledArguments(request: SubmissionRequest, config: IChatInputConfig, current: IChatInputConfig): boolean {
        if (request.source.kind !== 'arguments') return true;
        if (!config.input || !sameTargetRef(config.input.target, request.expectedTarget) || !sameInputDraft(current.input, config.input)) return false;
        try {if (canonicalSubmission(JSON.parse(config.input.json)) !== canonicalSubmission(request.source.value)) return false;} catch {return false;}
        this.ctx.chatInput.setConfig({input: undefined});
        return true;
    }

    protected async execute(params: SendMessageParams): Promise<boolean> {
        const input = {...params, expectedBranch: params.expectedBranch ?? this.ctx.getBranch?.(), files: [...params.files], target: params.target ? {...params.target} : undefined,
            submission: structuredClone(params.submission), overrides: normalizeOverrides(params.overrides, this.ctx)};
        const restore = this.rejectedInputRestorer(input.text, input.agentId);
        try {if (await dispatchDirectCommand(input.text, input.files, this.ctx.executeDirectCommand)) return true;}
        catch (error) {restore(); throw error;}
        const pending = this.preparePending(input);
        const feedback: ChatSubmission = {id: pending.id, text: input.text.trim() || (input.target?.kind === 'flow'
            ? t('callable.target.flow') : t('harness.attachmentPrompt')), timestamp: Date.now(), state: 'submitting'};
        return this.submit({input, pending, feedback, restore});
    }

    private preparePending(input: ActiveSend['input']): PendingSend {
        const sessionId = this.ctx.getSessionId();
        if (!sessionId) throw new Error('No session loaded');
        const key = canonicalSubmission([input.text, input.target ?? input.agentId, input.overrides, input.origin, input.historyPolicy,
            ...(input.target && input.expectedBranch ? [input.expectedBranch] : [])]);
        const previous = this.pending;
        if (previous?.sessionId === sessionId && previous.key === key && input.files.length === previous.files.length
            && input.files.every((file, index) => file === previous.files[index])) return previous;
        const operation = !input.files.length && input.target ? this.ctx.operations?.getSnapshot().find(record => record.conversationId === sessionId
            && record.kind === 'send' && (record.status === 'unknown' || record.status === 'submitting')
            && (record.input as {key?: string})?.key === key) : undefined;
        return this.pending = {sessionId, key, files: [...input.files], id: operation?.context.operationId ?? randomUUID()};
    }

    private async submit(active: ActiveSend): Promise<boolean> {
        this.present(active); this.ctx.chatInput.setLoading(true); this.ctx.historyView.scrollToBottom(true);
        try {
            const prepared = await this.prepareSubmission(active);
            if (!prepared) return false;
            const {input, pending} = active;
            const id = input.target ? await submitSessionCall(this.ctx, typedRequest(input.target, prepared.text, prepared.attachments,
                prepared.submission, input.overrides, input.origin, input.historyPolicy, input.expectedBranch), pending.key)
                : await this.ctx.commands.execute<string>(SessionCommand.Send, legacyRequest(input, prepared));
            await this.accepted(active, id); return true;
        } catch (error) {return this.failed(active, error);}
        finally {this.syncLoading(active.pending.sessionId);}
    }

    private async prepareSubmission(active: ActiveSend): Promise<PreparedSend | undefined> {
        const {input, pending} = active;
        let submission = input.submission ?? pending.submission;
        if (!submission && this.ctx.resolveSubmission) submission = await this.ctx.resolveSubmission();
        submission ??= {id: pending.id, source: {kind: 'conversation', ownerId: pending.sessionId, id: pending.id}};
        pending.submission = submission; this.present(active, {messageId: `round-${submission.id}-user`});
        const text = await this.upload(active, submission.id);
        if (text === undefined) return;
        if (!text.trim() && input.target?.kind !== 'flow' && !input.overrides.flowExpectedSignature && !input.overrides.flowId) {
            if (this.ctx.getSessionId() === pending.sessionId) this.ctx.historyView.setSubmission?.();
            return;
        }
        pending.finalText = text;
        return {text: text.trim(), submission, attachments: pending.attachments ?? []};
    }

    private async upload(active: ActiveSend, submissionId: string): Promise<string | undefined> {
        const {input, pending} = active;
        if (pending.finalText !== undefined) return pending.finalText;
        if (!input.files.length) return input.text;
        try {
            if (input.overrides.flowExpectedSignature) {
                await validateComposerFiles(input.files, input.overrides.flowParameters ?? {});
                pending.attachments = []; return input.text;
            }
            if (input.target && this.ctx.operations?.getSnapshot().some(record => record.context.operationId === submissionId))
                throw Object.assign(new Error(t('callable.submission.attachmentUnknown')), {outcome: 'unknown'});
            const uploaded = await this.ctx.assetService.prepareUpload(input.files, submissionId);
            pending.attachments = uploaded.files;
            return input.text + '\n\n' + uploaded.references.join('\n\n');
        } catch (error) {
            const failure = error as Error & {outcome?: string};
            this.present(active, {state: failure.outcome === 'unknown' ? 'unknown' : 'failed', error: failure.message});
            Toast.error(failure.message || 'Failed to upload files'); active.restore(); return;
        }
    }

    private async accepted(active: ActiveSend, acceptedId: string): Promise<void> {
        const queue = await this.ctx.commands.execute<import('@itookit/llm-session/contracts').SessionInstructionQueue>(SessionCommand.GetInstructionQueue).catch(() => undefined);
        if (queue?.items?.some(item => item.id === acceptedId && item.state !== 'dispatching')) this.ctx.historyView.setSubmission?.();
        else this.present(active, {state: 'accepted'});
        if (this.pending === active.pending) this.pending = undefined;
        const {input} = active;
        if (input.target?.kind !== 'flow' && !input.overrides.flowId && this.ctx.getSessionId() === active.pending.sessionId)
            this.ctx.chatInput.setConfig?.({settings: {executionMode: input.overrides.executionMode, executionModeLocked: true}});
    }

    private failed(active: ActiveSend, error: unknown): false {
        const failure = (error instanceof Error ? error : new Error('Unknown submission failure')) as Error & {code?: string; outcome?: string};
        active.restore(); this.present(active, {state: failure.outcome === 'unknown' ? 'unknown' : 'failed', error: failure.message});
        const classified = ErrorHandler.classifyError(failure);
        Toast.error(classified.userMessage);
        if (classified.isAuthError) this.ctx.historyView.renderError(failure);
        return false;
    }



    private present(active: ActiveSend, change: Partial<ChatSubmission> = {}): void {
        active.feedback = {...active.feedback, ...change};
        if (this.ctx.getSessionId() === active.pending.sessionId) this.ctx.historyView.setSubmission?.(active.feedback);
    }

    private syncLoading(sessionId: string): void {
        if (this.ctx.getSessionId() === sessionId) this.ctx.chatInput.setLoading(this.ctx.isGenerating?.() ?? false);
    }

    private rejectedInputRestorer(text: string, agentId?: string): () => void {
        const sessionId = this.ctx.getSessionId(), original = this.ctx.chatInput.getConfig?.().text;
        return () => {
            if (this.ctx.getSessionId() !== sessionId) return;
            const current = this.ctx.chatInput.getConfig?.().text;
            if ((original === undefined || original === '') && current === original) this.ctx.chatInput.restoreInput(text, agentId);
        };
    }
}

function normalizeOverrides(overrides: ChatOverrides | undefined, ctx: import('./CommandContext').CommandContext): ChatOverrides {
    const snapshot = structuredClone(overrides);
    return {...snapshot, executionMode: snapshot?.executionMode ?? ctx.chatInput.getConfig?.().settings?.executionMode ?? 'chat'};
}

function legacyRequest(input: ActiveSend['input'], prepared: PreparedSend) {
    const {overrides} = input, agentId = input.agentId || 'default';
    return {text: prepared.text, files: prepared.attachments,
        agentId, overrides, origin: input.origin, historyPolicy: input.historyPolicy, sendIntent: {...createAgentSendIntent(agentId), submission: prepared.submission,
            branch: {mode: overrides.branchMode ?? 'continue', baseRoundId: overrides.baseRoundId, newBranchName: overrides.newBranchName},
            retention: {mode: overrides.retentionMode ?? 'persistent'}, execution: overrides.flowId
                ? {kind: 'flow', flowId: overrides.flowId, revision: overrides.flowRevision, parameters: overrides.flowParameters}
                : {kind: 'agent', agentId, mode: overrides.executionMode}}};
}

function typedRequest(target: NonNullable<SendMessageParams['target']>, text: string, files: PreparedAttachmentUpload['files'],
    submission: NonNullable<SubmissionRequest['submission']>, overrides: ChatOverrides,
    origin?: SessionOrigin, historyPolicy?: HistoryPolicy, expectedBranch?: string): SubmissionRequest {
    const {flowParameters, flowId: _legacyFlow, flowRevision: _legacyRevision, ...settings} = overrides;
    const parameters = overrides.flowExpectedSignature ? flowParameters ?? {} : undefined;
    return {expectedBranch, target: {kind: target.kind, id: target.id, version: target.version}, expectedTarget: {...target},
        source: parameters ? {kind: 'arguments', value: parameters} : {kind: 'composer', text, attachments: [], values: {}},
        ...(parameters ? {presentation: {text}} : {}), submission, overrides: settings, origin, historyPolicy,
        attachments: structuredClone(files)};
}
