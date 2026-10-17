// @file: llm-ui/commands/CommandRegistry.ts

import { Command } from './Command';
import type { CommandContext } from './CommandContext';
import type { IEditorEventBus, EditorBusEvents } from '../domain/events';

import {
    CreateBranchCommand, SwitchBranchCommand, SwitchBranchByIdCommand,
    RenameBranchCommand, DeleteBranchCommand,
} from './BranchCommands';
import { BatchDeleteCommand, BatchCopyCommand } from './BatchCommands';
import { copyText, Toast } from '@itookit/ui-common';

/**
 * 命令注册中心
 * 
 * 依赖 IEditorEventBus 接口而非具体实现
 */
export class CommandRegistry {
    private unsubscribers: (() => void)[] = [];

    constructor(
        private ctx: CommandContext,
        private bus: IEditorEventBus
    ) {}

    /**
     * 注册所有命令并绑定到事件总线
     */
    initialize(): void {
        // 复杂命令保留独立类
        this.bindCommand('branch:create', new CreateBranchCommand(this.ctx));
        this.bindCommand('branch:switch', new SwitchBranchCommand(this.ctx));
        this.bindCommand('branch:switchById', new SwitchBranchByIdCommand(this.ctx));
        this.bindCommand('branch:rename', new RenameBranchCommand(this.ctx));
        this.bindCommand('branch:delete', new DeleteBranchCommand(this.ctx));
        this.bindCommand('batch:delete', new BatchDeleteCommand(this.ctx));
        this.bindCommand('batch:copy', new BatchCopyCommand(this.ctx));

        // 简单操作直接内联，消除 6 个单独的文件/类
        this.bindInline('nav:scrollTo', async ({ sessionId }) => {
            const el = this.ctx.historyView.getSessionElement(sessionId);
            if (!el) return;
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            el.classList.add('llm-ui-session--highlight');
            setTimeout(() => el.classList.remove('llm-ui-session--highlight'), 1500);
        });

        this.bindInline('nav:toggleFold', async ({ sessionId }) => {
            this.ctx.historyView.toggleSessionCollapse(sessionId);
        });

        this.bindInline('nav:foldAll', async () => {
            this.ctx.historyView.setAllCollapsed(true);
            this.emitCollapseStates(true);
        });

        this.bindInline('nav:unfoldAll', async () => {
            this.ctx.historyView.setAllCollapsed(false);
            this.emitCollapseStates(false);
        });

        this.bindInline('content:copy', async ({ sessionId }) => {
            const sessions = this.ctx.getSessions();
            const session = sessions.find(s => s.id === sessionId);
            if (!session) return;
            if (await copyText(session.content || '')) Toast.success('Copied to clipboard');
            else Toast.error('Copy failed');
        });
    }

    private emitCollapseStates(collapsed: boolean): void {
        const sessions = this.ctx.getSessions();
        const states: Record<string, boolean> = {};
        sessions.forEach(s => { states[s.id] = collapsed; });
        this.ctx.bus.emit('state:collapseChanged', { states });
    }

    private bindCommand<K extends keyof EditorBusEvents>(
        event: K, cmd: Command<any, any>
    ): void {
        this.unsubscribers.push(
            this.bus.on(event, (payload) => cmd.run(payload))
        );
    }

    private bindInline<K extends keyof EditorBusEvents>(
        event: K,
        handler: (payload: EditorBusEvents[K]) => Promise<void>
    ): void {
        this.unsubscribers.push(
            this.bus.on(event, (payload) => {
                // 修复：从 ctx 中获取 errorHandler
                this.ctx.errorHandler.wrap(() => handler(payload), event, 'silent');
            })
        );
    }

    destroy(): void {
        this.unsubscribers.forEach(unsub => unsub());
        this.unsubscribers = [];
    }
}
