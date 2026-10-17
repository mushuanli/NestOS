// @file: llm-ui/commands/WorkspaceCommands.ts


import { SessionCommand } from '@itookit/llm-session/contracts';
import { Command } from './Command';
import { LLMPrintService, type PrintService } from '@itookit/mdx-adapter';
import type { ErrorSeverity } from '../utils/errorHandler';
import type { IFileSystem } from '@itookit/vfs-core';
import { copyText } from '@itookit/ui-common';

/**
 * 复制整个会话为 Markdown
 */
export class CopyAllCommand extends Command {
    protected readonly name = 'Copy All';
    protected severity: ErrorSeverity = 'toast';

    protected async execute(): Promise<void> {
        const md = await this.ctx.commands.execute<string>(SessionCommand.Export);
        await copyText(md);
    }
}

/**
 * 打印会话
 */
export class PrintCommand extends Command<{ title: string; engine: IFileSystem; assets?: IFileSystem }> {
    protected readonly name = 'Print';
    protected severity: ErrorSeverity = 'warn';

    private printService: PrintService | null = null;

    protected async execute({ title, engine, assets }: {
        title: string; engine: IFileSystem; assets?: IFileSystem;
    }): Promise<void> {
        const md = await this.ctx.commands.execute<string>(SessionCommand.Export);
        if (!this.printService) {
            this.printService = new LLMPrintService(engine, undefined, assets);
        }
        try { await this.printService.print(md, {
            title: title || 'Chat Conversation',
            showHeader: true,
        }); } finally { this.printService.destroy?.(); this.printService = null; }
    }
}
