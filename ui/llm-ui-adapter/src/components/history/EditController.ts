// @file: llm-ui/components/history/EditController.ts

import { MDxController } from '../mdx/MDxController';
import type { NodeActionCallback } from '../../domain/types';

/**
 * 编辑模式控制器
 *
 * 职责：
 * 1. 跟踪哪些节点正在编辑
 * 2. 保存原始内容用于取消
 * 3. 进入/确认/取消编辑模式
 *
 * 设计要点：
 * - 编辑期间：onChange → onContentChange → updateDraft（仅内存）
 * - 确认编辑：onCommitEdit 或 onNodeAction('edit-and-retry')
 * - 取消编辑：恢复原始内容
 */
export class EditController {
    private editingNodes = new Set<string>();
    private originalContent = new Map<string, string>();

    constructor(
        private onContentChange?: (id: string, content: string, type: 'user' | 'node') => void,
        private onNodeAction?: NodeActionCallback,
        private onCommitEdit?: (id: string, content: string) => void,
    ) { }

    isEditing(nodeId: string): boolean {
        return this.editingNodes.has(nodeId);
    }

    // ================================================================
    // User Bubble 编辑
    // ================================================================

    toggleUserEdit(
        nodeId: string,
        controller: MDxController,
        actionsEl: HTMLElement,
        wrapper: HTMLElement
    ): void {
        if (!this.editingNodes.has(nodeId)) {
            this.enterEdit(nodeId, controller, actionsEl, wrapper);
        } else {
            this.confirmEdit(nodeId, controller, actionsEl, wrapper, false);
        }
    }

    private enterEdit(
        nodeId: string,
        controller: MDxController,
        actionsEl: HTMLElement,
        wrapper: HTMLElement
    ): void {
        this.originalContent.set(nodeId, controller.content);
        this.editingNodes.add(nodeId);
        controller.toggleEdit();
        actionsEl.style.display = 'flex';
        wrapper.querySelector('[data-action="edit"]')?.classList.add('active');

        // 如果折叠了，先展开
        const bubble = wrapper.querySelector('.llm-ui-bubble--user');
        if (bubble?.classList.contains('is-collapsed')) {
            const collapseBtn = wrapper.querySelector('[data-action="collapse"]') as HTMLElement;
            collapseBtn?.click();
        }
    }

    /**
     * 确认编辑
     * 
     * @param regenerate true = "Save & Run"（提交 + 重新生成），
     *                   false = "Save Only"（仅提交）
     */
    confirmEdit(
        nodeId: string,
        controller: MDxController,
        actionsEl: HTMLElement,
        wrapper: HTMLElement,
        regenerate: boolean
    ): void {
        const newContent = controller.content;
        const originalContent = this.originalContent.get(nodeId);
        const contentChanged = newContent !== originalContent;

        // 退出编辑模式
        this.editingNodes.delete(nodeId);
        this.originalContent.delete(nodeId);
        controller.toggleEdit();
        actionsEl.style.display = 'none';
        wrapper.querySelector('[data-action="edit"]')?.classList.remove('active');

        // 内容没有变化 → 不做任何操作
        if (!contentChanged && !regenerate) {
            return;
        }

        if (regenerate) {
            // "Save & Run"：
            // 1. 先更新内存中的草稿（确保 commitEdit 拿到最新内容）
            this.onContentChange?.(nodeId, newContent, 'user');
            // 2. 触发 edit-and-retry 命令（内部调用 commitEdit(autoRerun=true)）
            this.onNodeAction?.('edit-and-retry', nodeId);
        } else {
            // "Save Only"：
            // 仅在内容实际变化时才提交
            if (contentChanged) {
                this.onCommitEdit?.(nodeId, newContent);
            }
        }
    }

    cancelEdit(
        nodeId: string,
        controller: MDxController,
        actionsEl: HTMLElement,
        wrapper: HTMLElement
    ): void {
        const original = this.originalContent.get(nodeId);
        if (original !== undefined) {
            controller.setContent(original);
        }

        this.editingNodes.delete(nodeId);
        this.originalContent.delete(nodeId);
        controller.toggleEdit();
        actionsEl.style.display = 'none';
        wrapper.querySelector('[data-action="edit"]')?.classList.remove('active');
    }

    // ================================================================
    // Node 编辑
    // ================================================================

    async toggleNodeEdit(
        _nodeId: string,
        sessionId: string,
        controller: MDxController,
        actionEl: Element
    ): Promise<void> {
        const wasEditing = controller.isEditing();
        await controller.toggleEdit();
        actionEl.classList.toggle('active');

        if (wasEditing) {
            this.onContentChange?.(sessionId, controller.content, 'node');
        }
    }

    // ================================================================
    // 清理
    // ================================================================

    cleanup(nodeId: string): void {
        this.editingNodes.delete(nodeId);
        this.originalContent.delete(nodeId);
    }

    destroy(): void {
        this.editingNodes.clear();
        this.originalContent.clear();
    }
}
