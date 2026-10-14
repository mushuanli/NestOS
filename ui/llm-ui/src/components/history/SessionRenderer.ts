// @file: llm-ui/components/history/SessionRenderer.ts

import { SessionGroup, ExecutionNode } from '@itookit/llm-session/contracts';
import { MDxController, type MDxControllerOptions } from '../mdx/MDxController';
import { NodeRenderer } from './NodeRenderer';
import { NodeTemplates } from '../templates/NodeTemplates';
import { LayoutTemplates } from '../templates/LayoutTemplates';
import type { IFileSystem } from '@itookit/vfs-core';
import { t } from '@itookit/common';
import { TimerManager } from '../common';
import { getPreviewText } from '../../utils/textUtils';
import { IconResolver } from '../../utils/iconResolver';
import type { MDxPlugin } from '@itookit/mdxeditor';

export interface RendererContext {
    readOnly?: boolean;
    markdownPlugins?: MDxPlugin[];
    codeBlockControls?: MDxControllerOptions['codeBlockControls'];
    fs?: IFileSystem;
    assets?: IFileSystem;
    collapsedState?: (id: string, fallback: boolean) => boolean;
}

/**
 * Session/Node 的 DOM 渲染与编辑器生命周期管理
 *
 * 职责：
 * 1. 创建/销毁 session 和 node 的 DOM 结构
 * 2. 管理 MDxController 实例（editorMap）
 * 3. 管理 node 元素引用（nodeMap）
 * 4. 提供内容预览工具
 *
 * 不负责：事件绑定、折叠逻辑、编辑模式、流式更新
 */
export class SessionRenderer {
    private flowWindows = new Map<string, HTMLElement>();
    private nodeMap = new Map<string, HTMLElement>();
    private editorMap = new Map<string, MDxController>();
    private editorMounts = new Map<string, HTMLElement>();
    private renderedSessionIds = new Set<string>();
    private lastExecutionRoot: HTMLElement | null = null;
    private timers = new TimerManager();
    private snapshotContent = new Map<string, string>();

    constructor(
        private container: HTMLElement,
        private context: RendererContext,
        private onContentChange?: (id: string, content: string, type: 'user' | 'node') => void,
    ) { }

    // ================================================================
    // 访问器（供其他 Controller 使用）
    // ================================================================

    get editors(): Map<string, MDxController> { return this.editorMap; }



    getNode(nodeId: string): HTMLElement | null {
        return this.nodeMap.get(nodeId) || null;
    }

    getEditor(nodeId: string): MDxController | undefined {
        return this.editorMap.get(nodeId);
    }

    isEditorVisible(id: string): boolean {
        const mount = this.editorMounts.get(id);
        return !!mount && this.container.contains(mount) && !mount.closest('.is-collapsed');
    }

    activateVisibleEditors(root: HTMLElement = this.container): void {
        for (const [id, mount] of this.editorMounts) {
            if (root.contains(mount) && this.isEditorVisible(id)) this.editorMap.get(id)?.activate();
        }
    }

    getSessionElement(sessionId: string): HTMLElement | null {
        return this.container.querySelector(
            `[data-session-id="${sessionId}"], [data-history-id="${sessionId}"]`
        ) as HTMLElement | null;
    }

    isRendered(sessionId: string): boolean {
        return this.renderedSessionIds.has(sessionId);
    }

    // ================================================================
    // Session 渲染
    // ================================================================

    appendSession(group: SessionGroup, isCollapsed: boolean): void {
        if (this.renderedSessionIds.has(group.id)) {
            console.warn(`[SessionRenderer] Duplicate session: ${group.id}`);
            return;
        }
        this.renderedSessionIds.add(group.id);

        const wrapper = document.createElement('div');
        wrapper.className = `llm-ui-session llm-ui-session--${group.role}`;
        wrapper.dataset.sessionId = group.id;
        if (this.context.readOnly) {
            wrapper.dataset.role = group.executionRoot?.data.metaInfo?.nativeRole ?? group.role;
            wrapper.dataset.historyId = group.executionRoot?.id ?? group.id;
        }

        // origin CSS class + label element
        if (group.origin && group.origin !== 'user') {
            wrapper.classList.add(`llm-ui-session--origin-${group.origin}`);
        }
        if (group.historyPolicy === 'exclude') {
            wrapper.classList.add('llm-ui-session--ephemeral');
        }

        if (group.role === 'user') {
            const preview = getPreviewText(group.content || '');
            wrapper.innerHTML = NodeTemplates.renderUserBubble(group, preview, isCollapsed);
            this.container.appendChild(wrapper);
            this.mountUserEditor(wrapper, group);
        } else {
            // 修复：动态提取图标
            const icon = group.executionRoot
                ? IconResolver.getIcon(group.executionRoot)
                : '🤖';

            const originKey = group.origin === 'agent' || group.origin === 'system'
                ? `chat.origin.${group.origin}` as const
                : null;
            const originLabelHtml = originKey
                ? `<span class="llm-ui-session__origin-label">${t(originKey)}</span>`
                : '';

            wrapper.innerHTML = `
                <div class="llm-ui-avatar">${icon}</div>
                ${originLabelHtml}
                <div class="llm-ui-execution-root" id="container-${group.id}"></div>
            `;
            this.container.appendChild(wrapper);
            this.lastExecutionRoot = wrapper.querySelector('.llm-ui-execution-root');
        }
        this.restrictActions(wrapper);
    }

    async reconcileSessions(groups: SessionGroup[]): Promise<void> {
        if (!this.renderedSessionIds.size && groups.length) this.container.replaceChildren();
        const retained = new Set(groups.map(group => group.id));
        for (const id of this.renderedSessionIds) if (!retained.has(id)) {
            this.removeMessages([...this.getEditorIdsForSession(id), id], false);
            this.snapshotContent.delete(id);
        }
        for (const [index, group] of groups.entries()) {
            if (!this.isRendered(group.id)) {
                this.appendSession(group, false);
                if (group.executionRoot) this.renderExecutionTree(group.executionRoot, false);
            }
            this.updateSnapshotContent(group);
            const wrapper = this.getSessionElement(group.id)!;
            const at = this.container.children[index];
            if (at !== wrapper) this.container.insertBefore(wrapper, at ?? null);
        }
        if (!groups.length) this.renderWelcome();
        await Promise.all([...this.editorMap.entries()].filter(([id]) => this.isEditorVisible(id)).map(([, editor]) => editor.waitUntilReady()));
    }

    private updateSnapshotContent(group: SessionGroup): void {
        const content = group.executionRoot?.data.output ?? group.content ?? '';
        const id = group.executionRoot?.id ?? group.id;
        if (this.snapshotContent.get(group.id) !== content) {
            this.editorMap.get(id)?.setContent(content); this.snapshotContent.set(group.id, content);
            const preview = this.getSessionElement(group.id)?.querySelector('.llm-ui-header-preview');
            if (preview) preview.textContent = getPreviewText(content);
        }
        const node = group.executionRoot && this.getNode(id);
        if (node && group.executionRoot) {
            node.dataset.status = group.executionRoot.status;
            const status = node.querySelector('.llm-ui-node__status');
            if (status) { status.textContent = group.executionRoot.status; status.className = `llm-ui-node__status llm-ui-node__status--${group.executionRoot.status}`; }
        }
    }

    private restrictActions(element: HTMLElement): void {
        if (!this.context.readOnly) return;
        for (const button of element.querySelectorAll<HTMLElement>('[data-action]')) {
            if (!['copy', 'collapse'].includes(button.dataset.action!)) button.remove();
        }
        element.querySelector('.llm-ui-edit-actions')?.remove();
    }

    /**
     * 渲染执行树（递归）
     */
    renderExecutionTree(node: ExecutionNode, isCollapsed: boolean): void {
        this.appendNode(node.parentId, node, isCollapsed);
        node.children?.forEach(c => this.renderExecutionTree(c, isCollapsed));
    }

    appendNode(parentId: string | undefined, node: ExecutionNode, isCollapsed: boolean): void {
        isCollapsed = this.context.collapsedState?.(node.id, isCollapsed) ?? isCollapsed;
        if (this.nodeMap.has(node.id)) {
            console.warn(`[SessionRenderer] Duplicate node: ${node.id}`);
            return;
        }

        let parentEl: HTMLElement | null = null;
        if (parentId) {
            parentEl = this.nodeMap.get(parentId)?.querySelector('.llm-ui-node__children') || null;
        }
        if (!parentEl) {
            if (!this.lastExecutionRoot || !this.container.contains(this.lastExecutionRoot)) {
                const roots = this.container.querySelectorAll<HTMLElement>('.llm-ui-execution-root');
                this.lastExecutionRoot = roots.item(roots.length - 1);
            }
            parentEl = this.lastExecutionRoot;
        }

        if (!parentEl) return;
        if (node.data.metaInfo?.flowInteraction && parentId) parentEl = this.flowWindow(parentId, node, parentEl, isCollapsed);

        const { element } = NodeRenderer.create(node);

        if (isCollapsed) {
            element.classList.add('is-collapsed');
            element.querySelector('[data-action="collapse"]')?.setAttribute('aria-expanded', 'false');
            const svg = element.querySelector('[data-action="collapse"] svg');
            if (svg) svg.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
        }

        this.nodeMap.set(node.id, element);
        parentEl.appendChild(element);
        this.mountNodeEditor(element, node);
        this.restrictActions(element);
    }

    private flowWindow(parentId: string, node: ExecutionNode, fallback: HTMLElement, collapsed: boolean): HTMLElement {
        const root = this.nodeMap.get(parentId);
        if (!root?.parentElement) return fallback;
        const meta = node.data.metaInfo;
        const taskKey = `${parentId}:task:${node.executorId}`;
        const related = meta?.actor?.kind === 'tool' ? this.flowWindows.get(taskKey) : undefined;
        if (related) return related.querySelector<HTMLElement>('.llm-ui-flow-window__body')!;
        const key = `${parentId}:${meta?.parallelGroup ? `parallel:${meta.parallelGroup}` : `node:${node.id}`}`;
        let window = this.flowWindows.get(key);
        if (!window) {
            window = document.createElement('section');
            window.className = 'llm-ui-flow-window';
            window.dataset.flowGroup = key;
            window.dataset.historyId = `flow-window-${encodeURIComponent(meta?.parallelGroup ? `parallel:${meta.parallelGroup}` : `node:${node.id}`)}`;
            collapsed = this.context.collapsedState?.(window.dataset.historyId, collapsed) ?? collapsed;
            window.classList.toggle('is-collapsed', collapsed);
            window.innerHTML = `<div class="llm-ui-node__header"><span class="llm-ui-node__name"></span>${NodeTemplates.renderReadActions(collapsed)}</div><div class="llm-ui-flow-window__body"></div>`;
            root.dataset.historyId = root.dataset.id;
            root.dataset.role = 'assistant';
            window.dataset.role = node.messageRole ?? 'assistant';
            root.parentElement.insertBefore(window, root);
            this.flowWindows.set(key, window);
        }
        this.flowWindows.set(taskKey, window);
        const title = window.querySelector('.llm-ui-node__name')!;
        title.textContent = title.textContent ? `${title.textContent} · ${node.name}` : node.name;
        return window.querySelector<HTMLElement>('.llm-ui-flow-window__body')!;
    }

    copyContent(id: string): string | undefined {
        const editor = this.editorMap.get(id);
        if (editor) return editor.content;
        const window = this.getSessionElement(id);
        if (!window?.classList.contains('llm-ui-flow-window')) return undefined;
        return [...window.querySelectorAll<HTMLElement>('.llm-ui-node[data-id]')].map(node => {
            const content = this.editorMap.get(node.dataset.id!)?.content ?? '';
            const title = node.dataset.title ?? '';
            return content ? `## ${title}\n\n${content}` : '';
        }).filter(Boolean).join('\n\n');
    }

    updateRequests(nodeId: string, requests: unknown): void {
        if (!Array.isArray(requests)) return;
        const node = this.nodeMap.get(nodeId);
        const panel = node?.querySelector<HTMLDetailsElement>('.llm-ui-node__req');
        const pre = panel?.querySelector('pre');
        if (pre) pre.textContent = JSON.stringify(requests, null, 2);
    }

    // ================================================================
    // 编辑器挂载
    // ================================================================

    private mountUserEditor(wrapper: HTMLElement, group: SessionGroup): void {
        const mountPoint = wrapper.querySelector(`#user-mount-${group.id}`) as HTMLElement;
        if (!mountPoint) return;

        const controller = new MDxController(mountPoint, group.content || '', {
            readOnly: true,
            editable: this.context.readOnly ? false : undefined,
            plugins: this.context.markdownPlugins,
            codeBlockControls: this.context.codeBlockControls,
            deferred: !!mountPoint.closest('.is-collapsed'),
            onChange: (text) => {
                this.onContentChange?.(group.id, text, 'user');
                const previewEl = wrapper.querySelector('.llm-ui-header-preview');
                if (previewEl) previewEl.textContent = getPreviewText(text);
            },


            fs: this.context.fs,
            assets: this.context.assets,
        });
        this.editorMap.set(group.id, controller);
        this.editorMounts.set(group.id, mountPoint);
    }

    private mountNodeEditor(element: HTMLElement, node: ExecutionNode): void {
        const mountPoint = element.querySelector(`#mount-${node.id}`) as HTMLElement;
        if (!mountPoint) return;

        const sessionEl = element.closest('[data-session-id]');
        const effectiveId = (sessionEl as HTMLElement)?.dataset.sessionId || node.id;

        const isStreaming = node.status === 'running' || node.status === 'queued';

        const controller = new MDxController(mountPoint, node.data.output || '', {
            readOnly: true,
            editable: this.context.readOnly ? false : undefined,
            plugins: this.context.markdownPlugins,
            codeBlockControls: this.context.codeBlockControls,
            deferred: !!mountPoint.closest('.is-collapsed'),
            streaming: isStreaming && !this.context.readOnly,
            onChange: (text) => {
                if (controller.isEditing()) {
                    this.onContentChange?.(effectiveId, text, 'node');
                }
            },


            fs: this.context.fs,
            assets: this.context.assets,
        });
        this.editorMap.set(node.id, controller);
        this.editorMounts.set(node.id, mountPoint);

        const iconEl = element.querySelector('.llm-ui-node__icon--clickable');
        if (iconEl && node.data.metaInfo?.agentId) {
            (iconEl as HTMLElement).dataset.agentId = node.data.metaInfo.agentId;
        }
    }

    // ================================================================
    // 删除
    // ================================================================

    removeMessages(ids: string[], animated: boolean): string[] {
        const removed: string[] = [];

        for (const id of ids) {
            const sessionEl = this.container.querySelector(`[data-session-id="${id}"]`);
            const nodeEl = this.nodeMap.get(id);

            if (!sessionEl && !nodeEl) continue;

            this.renderedSessionIds.delete(id);

            if (sessionEl) this.removeElement(sessionEl as HTMLElement, animated);
            if (nodeEl) {
                this.removeElement(nodeEl, animated);
                this.nodeMap.delete(id);
            }

            const editor = this.editorMap.get(id);
            if (editor) {
                editor.destroy();
                this.editorMap.delete(id);
                this.editorMounts.delete(id);
            }

            removed.push(id);
        }

        const delay = animated ? 350 : 0;
        this.timers.setTimeout(() => this.checkEmpty(), delay);

        return removed;
    }

    private removeElement(el: HTMLElement, animated: boolean): void {
        if (animated) {
            el.classList.add('llm-ui-session--deleting');
            el.addEventListener('animationend', () => el.remove(), { once: true });
            this.timers.setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
        } else {
            el.remove();
        }
    }

    private checkEmpty(): void {
        const remaining = this.container.querySelectorAll(
            '.llm-ui-session:not(.llm-ui-session--deleting)'
        );
        if (remaining.length === 0) {
            this.renderWelcome();
        }
    }

    // ================================================================
    // 简单渲染
    // ================================================================

    renderWelcome(): void {
        this.clear();
        this.container.innerHTML = LayoutTemplates.renderWelcome();
    }

    // ================================================================
    // 工具方法
    // ================================================================

    /**
     * 获取指定 session 关联的所有编辑器 ID
     */
    getEditorIdsForSession(sessionId: string): string[] {
        const ids: string[] = [];
        if (this.editorMap.has(sessionId)) ids.push(sessionId);

        const sessionEl = this.getSessionElement(sessionId);
        if (sessionEl) {
            sessionEl.querySelectorAll('.llm-ui-node[data-id]').forEach(node => {
                const nodeId = (node as HTMLElement).dataset.id;
                if (nodeId && this.editorMap.has(nodeId)) ids.push(nodeId);
            });
        }
        return ids;
    }

    // ================================================================
    // 清理
    // ================================================================

    clear(): void {
        this.editorMap.forEach(editor => editor.destroy());
        this.editorMap.clear();
        this.editorMounts.clear();
        this.nodeMap.clear();
        this.flowWindows.clear();
        this.snapshotContent.clear();
        this.renderedSessionIds.clear();
        this.lastExecutionRoot = null;
        this.container.innerHTML = '';
    }

    destroy(): void {
        this.timers.destroy();
        this.clear();
    }
}
