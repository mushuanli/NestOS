import {getLocale} from '@itookit/common';
import type { PromptHistoryPort } from '@itookit/llm-session/contracts';
// @file: llm-ui/components/input/plugins/HistoryPlugin.ts

import type { InputPlugin, InputPluginContext } from './InputPlugin';
import { PopupPanel, PopupItem } from '@itookit/llm-ui';
import type { PromptHistoryEntry } from '@itookit/llm-session/contracts';
import { truncateText } from '../../../utils/textUtils';
import { formatTimeAgo } from '../../../utils/timeUtils';

/**
 * Prompt History 插件
 *
 * 交互设计（参考 bash/zsh/Warp）：
 * - 输入框为空时按 ↑：打开历史面板
 * - Ctrl+R / Cmd+R：打开历史搜索
 * - 面板内 ↑/↓ 导航，Enter 选中填入
 * - Esc 关闭
 * - 发送后自动记录到历史
 *
 * 不修改 ChatInput 核心代码，完全通过 Plugin 接口交互。
 */
export class HistoryPlugin implements InputPlugin {
    readonly id = 'prompt-history';
    readonly priority = 50;

    private ctx: InputPluginContext | null = null;
    private panel: PopupPanel | null = null;
    private cachedEntries: PromptHistoryEntry[] = [];

    constructor(private historyService: PromptHistoryPort) {}

    activate(ctx: InputPluginContext): void {
        this.ctx = ctx;

        this.panel = new PopupPanel(ctx.textarea, {locale: getLocale(), positionAnchor: ctx.textarea.closest<HTMLElement>('.llm-input') ?? undefined,
            maxVisible: 15,
            showSearch: true,
            searchPlaceholder: 'Search prompt history...',
            emptyText: 'No history yet',
            footerHint: '↑↓ Navigate · Enter Select · Del Remove · Esc Close',
            variant: 'history',
            animated: true,
            onDelete: (item) => this.handleDelete(item),
        });
    }

    // ================================================================
    // 键盘钩子
    // ================================================================

    onKeyDown(e: KeyboardEvent): boolean {
        if (this.panel?.isVisible) {
            // Delete/Backspace 删除选中项（面板内）
            if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
                // 由面板内的删除按钮处理，这里不拦截
            }

            return this.panel.handleKeyDown(e);
        }

        // Ctrl+R / Cmd+R：搜索历史
        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            e.preventDefault();
            this.openHistory();
            return true;
        }

        if (e.key === 'ArrowUp' && this.isInputEmpty() && this.isCursorAtStart()) {
            e.preventDefault();
            this.openHistory();
            return true;
        }

        return false;
    }

    // ================================================================
    // 发送钩子
    // ================================================================

    onAfterSend(text: string, agentId: string): void {
        this.historyService.add(text, { agentId }).catch(() => {});
    }

    // ================================================================
    // 核心逻辑
    // ================================================================

    private async openHistory(): Promise<void> {
        if (!this.ctx || !this.panel) return;

        try {
            this.cachedEntries = await this.historyService.getRecent(50);
        } catch {
            this.cachedEntries = [];
        }

        if (this.cachedEntries.length === 0) return;

        const items = this.entriesToItems(this.cachedEntries);

        this.panel.show(items, {
            onSelect: (item) => this.handleSelect(item),
            onClose: () => this.ctx?.focus(),
        });
    }

    private handleSelect(item: PopupItem): void {
        if (!this.ctx) return;

        const entry = this.cachedEntries.find(e => e.text === item.id);
        const text = entry?.text || item.label;

        this.ctx.setText(text);
        this.ctx.focus();
        this.ctx.setCursorPosition(text.length);
    }

    private handleDelete(item: PopupItem): void {
        this.historyService.remove(item.id).catch(() => {});
        this.cachedEntries = this.cachedEntries.filter(e => e.text !== item.id);
    }

    // ================================================================
    // 工具
    // ================================================================

    private entriesToItems(entries: PromptHistoryEntry[]): PopupItem[] {
        return entries.map(entry => ({
            id: entry.text,
            label: truncateText(entry.text, 80),
            description: formatTimeAgo(entry.timestamp),
            icon: entry.agentId && entry.agentId !== 'default' ? '🤖' : undefined,
            searchText: entry.text,
        }));
    }

    private isInputEmpty(): boolean {
        return !this.ctx?.getText().trim();
    }

    private isCursorAtStart(): boolean {
        return (this.ctx?.getCursorPosition() ?? 0) === 0;
    }

    deactivate(): void {
        this.panel?.destroy();
        this.panel = null;
        this.ctx = null;
        this.cachedEntries = [];
    }
}
