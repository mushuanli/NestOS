// @file: llm-ui/commands/BatchCommands.ts


import { SessionCommand, type SessionGroup } from '@itookit/llm-session/contracts';
import { Command } from './Command';
import { copyText, Toast } from '@itookit/ui-common';
import { extractExecutionOutput } from '../utils/textUtils';


export class BatchDeleteCommand extends Command<{ ids: string[] }> {
    protected name = 'Batch Delete';

    protected async execute({ ids }: { ids: string[] }): Promise<void> {
        if (ids.length === 0) return;

        const originalSessions = await this.ctx.commands.execute<SessionGroup[]>(SessionCommand.GetSessions);

        try {
            // 乐观更新 UI
            this.ctx.historyView.removeMessages(ids, true);

            // 数据层负责：删除节点 + 清理孤立 branch + 回传结果
            const result = await this.ctx.commands.execute<any>(SessionCommand.DeleteMessages, {
                messageIds: ids,
                options: {
                    deleteAssociatedResponses: true,
                    cleanupOrphanedBranches: true,
                },
            });

            // 结果通知
            const branchCount = result?.deletedBranches?.length ?? 0;
            const msg = branchCount > 0
                ? `Deleted ${ids.length} message(s) and ${branchCount} branch(es)`
                : `Deleted ${ids.length} message(s)`;
            Toast.success(msg);

        } catch (e) {
            // 回滚
            this.ctx.historyView.renderFull(originalSessions);
            throw e;
        }
    }
}

export class BatchCopyCommand extends Command<{ ids: string[] }> {
    protected name = 'Batch Copy';

    protected async execute({ ids }: { ids: string[] }): Promise<void> {
        if (ids.length === 0) return;

        const sessions = await this.ctx.commands.execute<SessionGroup[]>(SessionCommand.GetSessions);
        const sorted = ids.sort((a, b) => {
            const sA = sessions.find(s => s.id === a);
            const sB = sessions.find(s => s.id === b);
            return (sA?.timestamp || 0) - (sB?.timestamp || 0);
        });

        const content = sorted
            .map(id => {
                const s = sessions.find(s => s.id === id);
                if (!s) return null;
                let text = s.content || '';
                if (s.role === 'assistant' && s.executionRoot) {
                    text = extractExecutionOutput(s.executionRoot);
                }
                const role = s.role === 'user' ? 'User' : 'Assistant';
                const time = new Date(s.timestamp).toLocaleString();
                return `### ${role} (${time}):\n${text}`;
            })
            .filter(Boolean);

        if (await copyText(content.join('\n\n---\n\n'))) Toast.success(`Copied ${ids.length} messages`);
        else Toast.error('Copy failed');
    }
}
