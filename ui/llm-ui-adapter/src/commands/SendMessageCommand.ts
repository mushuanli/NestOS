// @file: llm-ui/commands/SendMessageCommand.ts


import { SessionCommand, type SessionOrigin, type HistoryPolicy } from '@itookit/llm-session/contracts';
import { Command } from './Command';
import { dispatchDirectCommand } from './direct-command';
import { randomUUID, t } from '@itookit/common';
import type { ChatSubmission } from '../domain/submission';
import { Toast } from '@itookit/ui-common';
import { ErrorHandler } from '../utils/errorHandler';
import type { ChatOverrides } from '../domain/types';
import { attachmentStorageName } from '../services/AssetService';

import { createAgentSendIntent } from '@itookit/llm-flow/contracts';

export interface SendMessageParams {
    text: string;
    files: File[];
    agentId?: string;
    overrides?: ChatOverrides;
    origin?: SessionOrigin;
    historyPolicy?: HistoryPolicy;
    submission?: import('@itookit/llm-flow/contracts').SendIntent['submission'];
}

export class SendMessageCommand extends Command<SendMessageParams, boolean> {
    protected name = 'Send Message';
    private pending?: { sessionId: string; key: string; files: File[]; id: string;
        submission?: import('@itookit/llm-flow/contracts').SendIntent['submission']; finalText?: string };

    protected async execute({ text, files, agentId, overrides, origin, historyPolicy, submission }: SendMessageParams): Promise<boolean> {
        const restoreInput = this.rejectedInputRestorer(text, agentId);
        overrides = { ...overrides,
            executionMode: overrides?.executionMode ?? this.ctx.chatInput.getConfig?.().settings?.executionMode ?? 'chat',
            ...(overrides?.flowParameters ? { flowParameters: structuredClone(overrides.flowParameters) } : {}),
        };
        try {
            if (await dispatchDirectCommand(text, files, this.ctx.executeDirectCommand)) return true;
        } catch (error) {
            restoreInput();
            throw error;
        }
        const sessionId = this.ctx.getSessionId();
        if (!sessionId) throw new Error('No session loaded');

        const key = JSON.stringify([text, agentId, overrides, origin, historyPolicy]);
        const previous = this.pending;
        if (!previous || previous.sessionId !== sessionId || previous.key !== key
            || files.length !== previous.files.length || files.some((file, index) => file !== previous.files[index])) {
            this.pending = { sessionId, key, files: [...files], id: randomUUID() };
        }
        const pending = this.pending!;
        let feedback: ChatSubmission = {id: pending.id, text: text.trim() || t('harness.attachmentPrompt'),
            timestamp: Date.now(), state: 'submitting'};
        const present = (change: Partial<ChatSubmission> = {}) => {
            feedback = {...feedback, ...change};
            if (this.ctx.getSessionId() === sessionId) this.ctx.historyView.setSubmission?.(feedback);
        };
        present();
        this.ctx.chatInput.setLoading(true);
        this.ctx.historyView.scrollToBottom(true);

        try {
            submission ??= pending.submission;
            if (submission === undefined && this.ctx.resolveSubmission) submission = await this.ctx.resolveSubmission();
            submission ??= {id: feedback.id, source: {kind: 'conversation', ownerId: sessionId, id: feedback.id}};
            pending.submission = submission;
            present({messageId: `round-${submission.id}-user`});
            let finalText = pending.finalText ?? text ?? '';

            if (files.length > 0 && pending.finalText === undefined) {
                try {
                    const refs = await this.ctx.assetService.uploadFiles(files, submission.id);
                    finalText += '\n\n' + refs.join('\n\n');
                } catch (uploadErr: any) {
                    present({state: 'failed', error: uploadErr.message});
                    Toast.error(uploadErr.message || 'Failed to upload files');
                    restoreInput();
                    this.syncLoading(sessionId);
                    return false;
                }
            }

            if (!finalText.trim()) {
                if (this.ctx.getSessionId() === sessionId) this.ctx.historyView.setSubmission?.();
                this.syncLoading(sessionId);
                return false;
            }
            pending.finalText = finalText;

            const acceptedId = await this.ctx.commands.execute<string>(SessionCommand.Send, {
                text: finalText.trim(),
                files: files.map((file, index) => ({ name: attachmentStorageName(submission!.id, index, file.name), type: file.type, size: file.size })),
                agentId: agentId || 'default',
                overrides,
                origin,
                historyPolicy,
                sendIntent: {
                    ...createAgentSendIntent(agentId || 'default'),
                    submission,
                    branch: {
                        mode: overrides?.branchMode ?? 'continue',
                        baseRoundId: overrides?.baseRoundId,
                        newBranchName: overrides?.newBranchName,
                    },
                    retention: { mode: overrides?.retentionMode ?? 'persistent' },
                    execution: overrides?.flowId
                        ? {
                            kind: 'flow',
                            flowId: overrides.flowId,
                            revision: overrides.flowRevision,
                            parameters: overrides.flowParameters,
                        }
                        : { kind: 'agent', agentId: agentId || 'default', mode: overrides.executionMode },
                },
            });
            const queue = await this.ctx.commands.execute<import('@itookit/llm-session/contracts').SessionInstructionQueue>(SessionCommand.GetInstructionQueue).catch(() => undefined);
            if (queue?.items?.some(item => item.id === acceptedId && item.state !== 'dispatching')) this.ctx.historyView.setSubmission?.();
            else present({state: 'accepted'});
            if (this.pending === pending) this.pending = undefined;
            this.syncLoading(sessionId);
            if (!overrides.flowId && this.ctx.getSessionId() === sessionId) this.ctx.chatInput.setConfig?.({ settings: { executionMode: overrides.executionMode, executionModeLocked: true } });
            return true;
        } catch (error: any) {
            // A rejected transport response does not prove the host rejected the send.
            // Preserve persisted rounds; only the host can reconcile accepted execution.
            restoreInput();

            present({state: error?.outcome === 'unknown' ? 'unknown' : 'failed', error: error?.message});
            const classified = ErrorHandler.classifyError(error);
            Toast.error(classified.userMessage);
            if (classified.isAuthError) {
                this.ctx.historyView.renderError(error);
            }

            this.syncLoading(sessionId);
            return false;
        }
    }

    private syncLoading(sessionId: string): void {
        if (this.ctx.getSessionId() === sessionId) this.ctx.chatInput.setLoading(this.ctx.isGenerating?.() ?? false);
    }

    private rejectedInputRestorer(text: string, agentId?: string): () => void {
        const sessionId = this.ctx.getSessionId();
        const original = this.ctx.chatInput.getConfig?.().text;
        return () => {
            if (this.ctx.getSessionId() !== sessionId) return;
            const current = this.ctx.chatInput.getConfig?.().text;
            if ((original === undefined || original === '') && current === original) this.ctx.chatInput.restoreInput(text, agentId);
        };
    }
}
