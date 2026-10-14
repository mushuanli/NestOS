// @file: llm-ui/commands/SendMessageCommand.ts


import { SessionCommand, type SessionOrigin, type HistoryPolicy } from '@itookit/llm-session/contracts';
import { Command } from './Command';
import { dispatchDirectCommand } from './direct-command';
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
        overrides = { ...overrides,
            executionMode: overrides?.executionMode ?? this.ctx.chatInput.getConfig?.().settings?.executionMode ?? 'chat',
            ...(overrides?.flowParameters ? { flowParameters: structuredClone(overrides.flowParameters) } : {}),
        };
        try {
            if (await dispatchDirectCommand(text, files, this.ctx.executeDirectCommand)) return true;
        } catch (error) {
            this.ctx.chatInput.restoreInput(text, agentId);
            throw error;
        }
        const sessionId = this.ctx.getSessionId();
        if (!sessionId) throw new Error('No session loaded');

        const savedText = text;
        const savedAgentId = agentId;

        this.ctx.chatInput.setLoading(true);
        this.ctx.historyView.scrollToBottom(true);

        try {
            if (submission === undefined && this.ctx.resolveSubmission) submission = await this.ctx.resolveSubmission();
            let finalText = text || '';

            if (files.length > 0) {
                try {
                    const refs = await this.ctx.assetService.uploadFiles(files);
                    finalText += '\n\n' + refs.join('\n\n');
                } catch (uploadErr: any) {
                    Toast.error(uploadErr.message || 'Failed to upload files');
                    this.ctx.chatInput.restoreInput(savedText, savedAgentId);
                    this.ctx.chatInput.setLoading(false);
                    return false;
                }
            }

            if (!finalText.trim()) {
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
            if (!overrides.flowId && this.ctx.getSessionId() === sessionId) this.ctx.chatInput.setConfig?.({ settings: { executionMode: overrides.executionMode, executionModeLocked: true } });
            return true;
        } catch (error: any) {
            // A rejected transport response does not prove the host rejected the send.
            // Preserve persisted rounds; only the host can reconcile accepted execution.
            this.ctx.chatInput.restoreInput(savedText, savedAgentId);

            const classified = ErrorHandler.classifyError(error);
            Toast.error(classified.userMessage);
            if (classified.isAuthError) {
                this.ctx.historyView.renderError(error);
            }

            this.ctx.chatInput.setLoading(false);
            return false;
        }
    }

}
