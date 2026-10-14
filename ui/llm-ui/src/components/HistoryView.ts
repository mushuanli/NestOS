// @file: llm-ui/components/HistoryView.ts

import type { SessionGroup, SessionEventEnvelope, ExecutionNode } from '@itookit/llm-session/contracts';
import type { IFileSystem } from '@itookit/vfs-core';
import type { IHistoryPresenter } from '../domain/ports/IHistoryPresenter';
import type { CollapseStateMap, NodeActionCallback } from '../domain/types';
import type { IEditorEventBus } from '../domain/events';
import {
    ScrollController, ContentResizeTracker, EventBatchProcessor,
    TimerManager, BatchedEvents,
} from './common';
import { ErrorTemplates } from './templates/ErrorTemplates';
import { getPreviewText } from '../utils/textUtils';

import { SessionRenderer, RendererContext } from './history/SessionRenderer';
import { StreamController } from './history/StreamController';
import { CollapseController } from './history/CollapseController';
import { EditController } from './history/EditController';
import { EventDispatcher } from './history/EventDispatcher';
import { TtyController } from './tty/TtyController';
import type { MDxPlugin } from '@itookit/mdxeditor';
import type { MDxControllerOptions } from './mdx/MDxController';

export interface HistoryViewOptions {
    readOnly?: boolean;
    markdownPlugins?: MDxPlugin[];
    codeBlockControls?: MDxControllerOptions['codeBlockControls'];
    onContentChange?: (id: string, content: string, type: 'user' | 'node') => void;
    onNodeAction?: NodeActionCallback;
    onCommitEdit?: (id: string, content: string) => void;
    bus?: IEditorEventBus;
    fs?: IFileSystem;
    assets?: IFileSystem;
    initialCollapseStates?: CollapseStateMap;
    onScroll?: () => void;
    /** 点击错误气泡中的"配置连接"按钮时触发（通常导航到 settings/connections） */
    onNavigateSettings?: () => void;
    /** Workspace-level notification used when the history pane is hidden. */
    onHistoryActivity?: (kind: 'update' | 'error', error?: Error) => void;
}

/**
 * HistoryView — 实现 IHistoryPresenter
 *
 * Shell 通过 IHistoryPresenter 接口交互，
 * 内部细节（5 个子控制器）完全封装。
 */
export class HistoryView implements IHistoryPresenter {
    private container: HTMLElement;

    // 子控制器
    private renderer: SessionRenderer;
    private stream: StreamController;
    private collapse: CollapseController;
    private edit: EditController;
    private dispatcher: EventDispatcher;
    private ttyCtrl: TtyController;

    // 基础设施
    private scrollController: ScrollController;
    private resizeTracker: ContentResizeTracker;
    private eventProcessor: EventBatchProcessor<SessionEventEnvelope>;
    private timers = new TimerManager();

    private newContentIndicator: HTMLElement | null = null;
    private bus?: IEditorEventBus;
    private suppressScrollHighlight = false;
    private onHistoryActivity?: HistoryViewOptions['onHistoryActivity'];

    constructor(container: HTMLElement, options: HistoryViewOptions) {
        this.container = container;
        this.bus = options.bus;
        this.onHistoryActivity = options.onHistoryActivity;

        const ctx: RendererContext = {


            fs: options.fs,
            assets: options.assets,
            readOnly: options.readOnly,
            markdownPlugins: options.markdownPlugins,
            codeBlockControls: options.codeBlockControls,
            collapsedState: (id, fallback) => this.collapse?.getStates()[id] ?? fallback,
        };

        this.renderer = new SessionRenderer(container, ctx, options.onContentChange);

        this.scrollController = new ScrollController(container, {
            onUserScrolledUp: () => {
                // Only show the indicator during streaming — scrolling up
                // while reviewing old content is normal reading, not "new content".
                if (this.stream.isStreamingMode) {
                    this.showNewContentIndicator();
                }
            },
            onUserScrolledDown: () => this.hideNewContentIndicator(),
            onScroll: () => {
                if (!this.suppressScrollHighlight) {
                    options.onScroll?.();
                }
            },
        });

        this.stream = new StreamController(container, this.renderer, this.scrollController);

        this.collapse = new CollapseController(
            container, this.renderer, options.bus, options.initialCollapseStates
        );

        this.edit = new EditController(
            options.onContentChange,
            options.onNodeAction,
            options.onCommitEdit,
        );

        this.dispatcher = new EventDispatcher(
            container, this.renderer, this.stream,
            this.collapse, this.edit, options.bus, options.onNodeAction,
            options.onNavigateSettings,
        );

        this.ttyCtrl = new TtyController((id) => this.renderer.getNode(id) ?? undefined);

        this.resizeTracker = new ContentResizeTracker(
            container,
            (newH, oldH) => {
                // 仅在非流式且非退出保护窗口内，才将高度增长视为"新内容"
                if (newH > oldH && !this.stream.isStreamingMode && !this.stream.recentlyExited) {
                    this.scrollController.handleContentResize();
                }
            }
        );

        // 使用泛化的 EventBatchProcessor
        this.eventProcessor = new EventBatchProcessor<SessionEventEnvelope>(
            (batched) => this.handleBatchedEvents(batched),
            (event) => this.processEventImmediate(event),
            {
                interval: 50,
                immediateTypes: [
                    'finished', 'error',
                    'regenerate_started', 'regenerate_completed',
                    // Claude Code Agent Loop — 需要立即处理的事件
                    'tool:queued',
                    'tool:running',
                    'tool:input',
                    'tool:progress',
                    'stream:thinking:stop',
                    'tool:success', 'tool:error',
                    // LLM 2.0 canonical events (S7)
                    'message:appended', 'message:status', 'node:appended',
                    'messages:cleared', 'messages:deleted',
                    'sibling:switched',
                    'branch:switched',
                    'stream:content', 'stream:thinking',
                    // 联网搜索结果引用（终态一次性）
                    'message:citations',
                ],
            }
        );
    }

    // ================================================================
    // IHistoryPresenter 实现
    // ================================================================

    renderFull(sessions: SessionGroup[], options?: { position?: 'top' | 'bottom' }): void {
        this.clear();
        if (sessions.length === 0) {
            this.renderer.renderWelcome();
            return;
        }

        const totalCount = sessions.length;
        sessions.forEach((session, index) => {
            const shouldCollapse = this.collapse.computeInitialState(
                session.id, session.role, index, totalCount
            );
            this.renderer.appendSession(session, shouldCollapse);
            if (session.executionRoot) {
                this.renderer.renderExecutionTree(session.executionRoot, shouldCollapse);
            }
        });

        if (options?.position === 'top') {
            this.scrollController.forceScrollToTop();
        } else {
            this.scrollToBottom(true);
        }
    }

    renderWelcome(): void {
        this.renderer.renderWelcome();
    }

    /** Reconcile flat native history snapshots without recreating existing editors. */
    async renderSnapshot(sessions: SessionGroup[]): Promise<void> {
        await this.renderer.reconcileSessions(sessions);
    }

    renderError(error: Error): void {
        this.onHistoryActivity?.('error', error);
        this.container.querySelector('.llm-ui-error-banner')?.remove();

        const banner = document.createElement('div');
        banner.className = 'llm-ui-error-banner';
        banner.innerHTML = ErrorTemplates.renderErrorBanner(error.message);

        banner.querySelector('.llm-ui-error-banner__close')?.addEventListener('click', () => {
            banner.remove();
        });

        const isSerious = error.message.includes('401') || error.message.includes('API key');
        if (!isSerious) {
            this.timers.setTimeout(() => { if (banner.parentNode) banner.remove(); }, 5000);
        }

        this.container.insertBefore(banner, this.container.firstChild);
        this.scrollController.scrollToBottom(true);
    }

    clearErrors(): void {
        this.container.querySelectorAll('.llm-ui-error-banner').forEach(el => el.remove());
        this.container.querySelectorAll('.llm-ui-session--system').forEach(el => el.remove());
    }



    removeMessages(ids: string[], animated: boolean): string[] {
        for (const id of ids) {
            this.edit.cleanup(id);
            this.stream.cleanupNode(id);
        }
        return this.renderer.removeMessages(ids, animated);
    }

    getCollapseStates(): CollapseStateMap {
        return this.collapse.getStates();
    }

    resetCollapseStates(): void {
        this.collapse.resetStates();
    }

    toggleSessionCollapse(sessionId: string, forceState?: boolean): void {
        const expanded = this.collapse.toggleSession(sessionId, forceState);
        if (expanded) {
            this.collapse.collapseCodeBlocksInSession(sessionId);
        }
    }

    setAllCollapsed(collapsed: boolean): void {
        this.collapse.setAllCollapsed(collapsed);
    }

    toggleAllFold(): boolean {
        return this.collapse.toggleAll();
    }

    shouldShowCollapseIcon(): boolean {
        return this.collapse.shouldCollapse();
    }

    foldCurrentUnfolded(): void {
        this.collapse.foldCurrentUnfolded();
    }

    scrollToBottom(force: boolean = false): void {
        if (force) {
            this.scrollController.forceScrollToBottom();
        } else {
            this.scrollController.scrollToBottom(false);
        }
    }

    enterStreamingMode(): void {
        this.stream.enter();
        this.suppressScrollHighlight = true;
        this.resizeTracker.suspend();
    }

    exitStreamingMode(): void {
        this.stream.exit();
        this.suppressScrollHighlight = false;
        this.resizeTracker.resume();

        if (!this.scrollController.isUserScrolledUp) {
            this.scrollController.scrollToBottom(true);
        } else {
            this.showNewContentIndicator();
        }
    }

    getSessionElement(sessionId: string): HTMLElement | null {
        return this.renderer.getSessionElement(sessionId);
    }

    getElement(id: string): HTMLElement | null {
        return this.renderer.getSessionElement(id) || this.renderer.getNode(id);
    }

    getUnfoldedNavigationTarget(
        direction: 'prev' | 'next'
    ): string | null | '__end__' | '__start__' {
        return this.collapse.findUnfoldedByViewport(direction);
    }

    processEvent(event: SessionEventEnvelope): void {
        if (event.type === 'finished' || event.type === 'message:appended') {
            this.onHistoryActivity?.('update');
        } else if (event.type === 'error') {
            this.onHistoryActivity?.('error');
        }
        this.eventProcessor.push(event);
    }

    // ================================================================
    // 内部事件处理
    // ================================================================

    private handleBatchedEvents(batched: BatchedEvents<SessionEventEnvelope>): void {
        // Enter streaming mode before rendering any content chunks
        if (batched.chunks.size > 0) {
            this.enterStreamingMode();
        }

        // Process structural events first (node_start etc.) so nodes exist in the
        // DOM before we try to write streaming content into them.
        for (const event of batched.immediate) {
            this.processEventImmediate(event);
        }

        for (const [nodeId, chunks] of batched.chunks) {
            if (chunks.thought) this.stream.updateContent(nodeId, chunks.thought, 'thought');
            if (chunks.output) this.stream.updateContent(nodeId, chunks.output, 'output');
        }

        for (const [nodeId, { status, result }] of batched.statusChanges) {
            this.stream.updateStatus(nodeId, status, result);
        }

        for (const [nodeId, metaInfo] of batched.metaUpdates) {
            this.ttyCtrl.handleMeta(nodeId, metaInfo);
            this.renderer.updateRequests(nodeId, metaInfo.requests);
        }
    }
    private processEventImmediate(event: SessionEventEnvelope): void {
        // SessionEventBus 已在边界把 canonical AgentEvent 平铺字段折叠进 payload，
        // 此处统一按 event.type 收窄、从 event.payload 读取。
        switch (event.type) {
            case 'finished':
                this.exitStreamingMode();
                this.renderer.editors.forEach(editor => editor.finalize().catch(err => console.error('[HistoryView] finalize failed:', err)));
                this.clearErrors();
                this.bus?.emit('state:collapseChanged', {
                    states: this.collapse.getStates(),
                });
                break;

            case 'error': {
                this.exitStreamingMode();
                // 归一化后错误信息在 payload.error（AgentEventError 形状），code 为字符串。
                const err = event.payload.error;
                const msg = err?.message ?? 'Unknown error';
                const code = err?.code;
                const prefix = code === '401' ? '🔐 ' : code === '429' ? '⏳ ' : '';
                this.appendErrorBubble(new Error(`${prefix}${msg}`), code === 'ABORTED');
                this.renderer.editors.forEach(editor => editor.finalize().catch(err => console.error('[HistoryView] finalize failed:', err)));
                break;
            }

            case 'regenerate_started':
                this.clearErrors();
                this.enterStreamingMode();
                break;

            case 'regenerate_completed':
                break;

            // ── Claude Code Agent Loop 事件 ───────────────────────────────
            case 'tool:queued':
                // 工具节点由 execution tree（message:appended）创建，此处仅更新状态。
                this.stream.updateStatus(event.payload.call.toolId, 'queued');
                break;

            case 'tool:input': {
                const toolEl = this.renderer.getNode(event.payload.call.toolId);
                if (toolEl) {
                    const inputPre = toolEl.querySelector('.llm-ui-node__input pre') as HTMLElement;
                    if (inputPre) {
                        inputPre.textContent = (inputPre.textContent || '') + event.payload.call.delta;
                    }
                }
                break;
            }

            case 'tool:running':
                this.stream.updateStatus(event.payload.call.toolId, 'running');
                break;

            case 'tool:progress':
                this.stream.updateToolProgress(event.payload.call.toolId, event.payload.call.progress);
                break;

            case 'tool:success':
                this.stream.updateStatus(event.payload.call.toolId, 'success', event.payload.call.result);
                break;

            case 'tool:error':
                this.stream.updateStatus(event.payload.call.toolId, 'failed', event.payload.call.error);
                break;

            // Tool invocation nodes are created by the execution tree projection.
            case 'node:appended':
                this.renderer.appendNode(event.payload.parentId, event.payload.node, false);
                break;

            case 'round:start':
            case 'round:end':
                break;

            // ── LLM 2.0 canonical events (S7) ─────────────────────────────
            case 'message:appended': {
                const { sessionGroup, isExecutionRoot, parentId: _parentId } = event.payload;
                if (!sessionGroup) {
                    console.warn('[HistoryView] message:appended missing sessionGroup', event.payload);
                    break;
                }
                if (isExecutionRoot) {
                    // Step 1: create the session bubble (avatar + execution-root container)
                    this.renderer.appendSession(sessionGroup, false);
                    this.collapse.setState(sessionGroup.id, false);
                    // Step 2: mount the root ExecutionNode into the execution-root container
                    const rootNode = sessionGroup.executionRoot;
                    if (rootNode) {
                        this.renderer.appendNode(undefined, rootNode, false);
                        // Step 3: recursively mount any pre-existing children
                        rootNode.children?.forEach((c: ExecutionNode) =>
                            this.renderer.renderExecutionTree(c, false)
                        );
                    } else {
                        console.warn('[HistoryView] message:appended isExecutionRoot missing executionRoot', sessionGroup);
                    }
                    this.scrollController.scrollToBottom(false);
                } else {
                    this.clearErrors();
                    this.enterStreamingMode();
                    const isUser = sessionGroup.role === 'user';
                    const isAgentOrigin = sessionGroup.origin === 'agent' || sessionGroup.origin === 'system';
                    const defaultCollapsed = isUser || isAgentOrigin;
                    this.renderer.appendSession(sessionGroup, defaultCollapsed);
                    this.collapse.setState(sessionGroup.id, defaultCollapsed);
                    this.scrollController.scrollToBottom(false);
                }
                break;
            }

            case 'message:updated': {
                if (event.payload.content !== undefined) this.stream.replaceContent(event.payload.messageId, event.payload.content, event.payload.field ?? 'output');
                break;
            }

            case 'message:status': {
                const sp = event.payload;
                this.stream.updateStatus(sp.messageId, sp.status, sp.result);
                break;
            }

            case 'messages:cleared':
                this.renderer.renderWelcome();
                break;

            case 'messages:deleted':
                this.removeMessages(event.payload.deletedIds, true);
                break;

            case 'message:edited': {
                const ep = event.payload;
                const el2 = this.renderer.getSessionElement(ep.messageId);
                if (el2) {
                    const preview = el2.querySelector('.llm-ui-header-preview');
                    if (preview) {
                        preview.textContent = getPreviewText(ep.newContent);
                    }
                }
                break;
            }

            case 'sibling:switched': {
                const ssp = event.payload;
                const el3 = this.renderer.getSessionElement(ssp.messageId);
                if (!el3) break;
                const indicator = el3.querySelector('.llm-ui-branch-indicator');
                if (indicator) indicator.textContent = `${ssp.newIndex + 1}/${ssp.total}`;
                const prevBtn = el3.querySelector('[data-action="prev-sibling"]') as HTMLButtonElement;
                const nextBtn = el3.querySelector('[data-action="next-sibling"]') as HTMLButtonElement;
                if (prevBtn) prevBtn.disabled = ssp.newIndex === 0;
                if (nextBtn) nextBtn.disabled = ssp.newIndex === ssp.total - 1;
                break;
            }

            case 'stream:content':
            case 'stream:thinking':
                break;

            case 'message:citations': {
                const p = (event as any).payload as { messageId?: string; citations?: import('@itookit/driver-llm/contracts').Citation[] } | undefined;
                if (p?.messageId && p?.citations?.length) {
                    this.stream.updateCitations(p.messageId, p.citations);
                }
                break;
            }
        }
    }

    // ================================================================
    // 内部辅助
    // ================================================================

    private appendErrorBubble(error: Error, cancelled = false): void {
        this.stream.exit();

        const wrapper = document.createElement('div');
        wrapper.className = 'llm-ui-session llm-ui-session--system';

        // 匹配 "API key"/"apiKey"/"401" 等多种认证错误形态（大小写不敏感），
        // 命中时显示"配置连接"入口。
        const isAuthError = /api\s?key|401/i.test(error.message);
        wrapper.innerHTML = ErrorTemplates.renderErrorBubble(error.message, isAuthError, cancelled);

        this.container.appendChild(wrapper);
        this.scrollController.scrollToBottom(true);
    }

    private showNewContentIndicator(): void {
        if (this.newContentIndicator) return;

        this.newContentIndicator = document.createElement('div');
        this.newContentIndicator.className = 'llm-ui-new-content-indicator';
        this.newContentIndicator.innerHTML = ErrorTemplates.renderNewContentIndicator();

        this.newContentIndicator.querySelector('button')?.addEventListener('click', () => {
            this.scrollController.forceScrollToBottom();
            this.hideNewContentIndicator();
        });

        this.container.appendChild(this.newContentIndicator);
    }

    private hideNewContentIndicator(): void {
        if (this.newContentIndicator) {
            this.newContentIndicator.remove();
            this.newContentIndicator = null;
        }
    }

    // ================================================================
    // 清理
    // ================================================================

    private clear(): void {
        this.stream.destroy();
        this.edit.destroy();
        this.ttyCtrl.destroyAll();
        this.renderer.clear();
        this.stream = new StreamController(this.container, this.renderer, this.scrollController);
    }

    destroy(): void {
        this.timers.destroy();
        this.eventProcessor.destroy();
        this.scrollController.destroy();
        this.resizeTracker.destroy();
        this.dispatcher.destroy();
        this.stream.destroy();
        this.collapse.destroy();
        this.edit.destroy();
        this.ttyCtrl.destroyAll();
        this.renderer.destroy();
        this.hideNewContentIndicator();
        this.container.innerHTML = '';
    }
}
