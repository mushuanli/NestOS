// @file: llm-ui/commands/SendMessageCommand.ts


import { SessionCommand, type SessionOrigin, type HistoryPolicy } from '@itookit/llm-session/contracts';
import { Command } from './Command';
import { dispatchDirectCommand } from './direct-command';
import { t } from '@itookit/common';
import type { ChatSubmission } from '../domain/submission';
import { Toast } from '@itookit/ui-common';
import { ErrorHandler } from '../utils/errorHandler';
import type { ChatOverrides } from '../domain/types';

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

        let feedback: ChatSubmission = {id: crypto.randomUUID(), text: text.trim() || t('harness.attachmentPrompt'),
            timestamp: Date.now(), state: 'submitting'};
        const present = (change: Partial<ChatSubmission> = {}) => {
            feedback = {...feedback, ...change};
            if (this.ctx.getSessionId() === sessionId) this.ctx.historyView.setSubmission?.(feedback);
        };
        present();
        this.ctx.chatInput.setLoading(true);
        this.ctx.historyView.scrollToBottom(true);

        try {
            if (submission === undefined && this.ctx.resolveSubmission) submission = await this.ctx.resolveSubmission();
            submission ??= {id: feedback.id, source: {kind: 'conversation', ownerId: sessionId, id: feedback.id}};
            present({messageId: `round-${submission.id}-user`});
            let finalText = text || '';

            if (files.length > 0) {
                try {
                    const refs = await this.ctx.assetService.uploadFiles(files);
                    finalText += '\n\n' + refs.join('\n\n');
                } catch (uploadErr: any) {
                    present({state: 'failed', error: uploadErr.message});
                    Toast.error(uploadErr.message || 'Failed to upload files');
                    restoreInput();
                    this.ctx.chatInput.setLoading(false);
                    return false;
                }
            }

            if (!finalText.trim()) {
                if (this.ctx.getSessionId() === sessionId) this.ctx.historyView.setSubmission?.();
                this.ctx.chatInput.setLoading(false);
                return false;
            }

            await this.ctx.commands.execute(SessionCommand.Send, {
                text: finalText.trim(),
                files,
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
            present({state: 'accepted'});
            if (this.ctx.getSessionId() === sessionId && this.ctx.isGenerating) this.ctx.chatInput.setLoading(this.ctx.isGenerating());
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

            this.ctx.chatInput.setLoading(false);
            return false;
        }
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
