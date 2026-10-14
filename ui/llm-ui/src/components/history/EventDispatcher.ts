// @file: llm-ui/components/history/EventDispatcher.ts

import { EventCleanup, TimerManager } from '../common';
import { copyText, showConfirmDialog } from '@itookit/ui-common';
import type { SessionRenderer } from './SessionRenderer';
import type { StreamController } from './StreamController';
import type { CollapseController } from './CollapseController';
import type { EditController } from './EditController';
import type { IEditorEventBus } from '../../domain/events';
import type { NodeActionCallback, NodeAction } from '../../domain/types';

/**
 * 事件委托分发器
 *
 * 职责：
 * 1. 在 container 上注册单一 click 事件委托
 * 2. 根据 data-action 路由到对应的 Controller
 *
 * 使用 Strategy 模式：每个 action 是一个处理函数，
 * 注册在 actionMap 中，替代 15-case switch。
 */
export class EventDispatcher {
    private events = new EventCleanup();
    private timers = new TimerManager();
    private actionMap = new Map<string, ActionHandler>();

    constructor(
        private container: HTMLElement,
        private renderer: SessionRenderer,
        private stream: StreamController,
        private collapse: CollapseController,
        private edit: EditController,
        private bus: IEditorEventBus | undefined,
        private onNodeAction: NodeActionCallback | undefined,
        private onNavigateSettings?: () => void,
    ) {
        this.registerActions();
        this.bindDelegation();
    }
    private fireNodeAction(action: NodeAction, nodeId: string): void {
        this.onNodeAction?.(action, nodeId);
    }

    // ================================================================
    // 动作注册（Strategy Map）
    // ================================================================

    private registerActions(): void {
        const m = this.actionMap;

        m.set('collapse', (ctx) => {
            const collapsible = ctx.actionEl.closest(
                '.llm-ui-bubble--user, .llm-ui-node, .llm-ui-flow-window'
            ) as HTMLElement;
            if (!collapsible) return;

            const expanded = this.collapse.toggle(
                collapsible, ctx.actionEl, collapsible.dataset.historyId || collapsible.dataset.id || ctx.sessionId,
                this.stream.isStreamingMode
            );

            if (expanded && ctx.sessionId) {
                this.collapse.collapseCodeBlocksInSession(ctx.sessionId);
            }
        });

        m.set('copy', (ctx) => {
            const content = this.renderer.copyContent(ctx.nodeId) ?? this.renderer.copyContent(ctx.sessionId);
            if (content !== undefined) this.handleCopy(content, ctx.actionEl);
        });

        m.set('delete', (ctx) => {
            const role = ctx.sessionEl?.classList.contains('llm-ui-session--user')
                ? 'user' : 'assistant';
            this.handleDelete(ctx.sessionId, role);
        });


        m.set('resend', (ctx) => this.fireNodeAction('regenerate', ctx.sessionId));
        m.set('regenerate', (ctx) => this.fireNodeAction('regenerate', ctx.sessionId));
        m.set('retry', (ctx) => this.fireNodeAction('regenerate', ctx.sessionId));

        m.set('prev-sibling', (ctx) => this.fireNodeAction('prev-sibling', ctx.sessionId));
        m.set('next-sibling', (ctx) => this.fireNodeAction('next-sibling', ctx.sessionId));

        m.set('create-branch', (ctx) => {
            this.bus?.emit('branch:create', {
                sourceNodeId: ctx.sessionId || ctx.nodeId,
            });
        });

        // Click agent icon → navigate to agent editor
        m.set('edit-agent', (ctx) => {
            const agentId = ctx.actionEl.dataset.agentId;
            if (agentId) {
                this.fireNodeAction('edit-agent', agentId);
            }
        });

        // 编辑相关
        m.set('edit', (ctx) => this.handleEditAction(ctx));
        m.set('confirm-edit', (ctx) => this.handleConfirmEdit(ctx, true));
        m.set('save-only', (ctx) => this.handleConfirmEdit(ctx, false));
        m.set('cancel-edit', (ctx) => this.handleCancelEdit(ctx));

        // 错误操作
        m.set('open-settings', () => {
            this.onNavigateSettings?.();
        });

        m.set('retry-last', (ctx) => {
            ctx.actionEl.closest('.llm-ui-session--system')?.remove();
            const lastId = this.findLastRetryableId();
            if (lastId) this.fireNodeAction('regenerate', lastId);
        });
    }

    // ================================================================
    // 事件委托
    // ================================================================

    private bindDelegation(): void {
        this.events.add(this.container, 'click', ((e: MouseEvent) => {
            const target = e.target as HTMLElement;

            // 优先处理 agent 图标点击（导航到 Agent 编辑器）
            const agentIcon = target.closest('.llm-ui-node__icon--clickable') as HTMLElement;
            if (agentIcon) {
                const agentId = agentIcon.dataset.agentId;
                if (agentId) {
                    e.stopPropagation();
                    this.handleAgentIconClick(agentId);
                    return;
                }
            }

            // thinking 面板 toggle：点击标签折叠/展开
            const thoughtLabel = target.closest('.llm-ui-thought__label') as HTMLElement;
            if (thoughtLabel) {
                const thoughtEl = thoughtLabel.closest('.llm-ui-thought') as HTMLElement;
                if (thoughtEl) {
                    thoughtEl.classList.toggle('llm-ui-thought--collapsed');
                }
                return;
            }

            // 折叠的 thinking 面板任意位置点击展开
            const collapsedThought = target.closest('.llm-ui-thought--collapsed') as HTMLElement;
            if (collapsedThought) {
                collapsedThought.classList.remove('llm-ui-thought--collapsed');
                return;
            }

            // citations 面板 toggle：点击标签折叠/展开
            const citationsLabel = target.closest('.llm-ui-citations__label') as HTMLElement;
            if (citationsLabel) {
                const citationsEl = citationsLabel.closest('.llm-ui-citations') as HTMLElement;
                if (citationsEl) {
                    citationsEl.classList.toggle('llm-ui-citations--collapsed');
                }
                return;
            }

            // data-action 委托
            const actionEl = target.closest('[data-action]') as HTMLElement;
            if (!actionEl) return;

            const action = actionEl.dataset.action;
            if (!action) return;

            // This delegated action owns the click. stopPropagation() alone
            // does not prevent a stale second EventDispatcher attached to the
            // same container from consuming the same physical click.
            e.stopImmediatePropagation();

            const sessionEl = actionEl.closest('[data-session-id]') as HTMLElement;
            const nodeEl = actionEl.closest('.llm-ui-node, .llm-ui-flow-window') as HTMLElement;

            const ctx: ActionContext = {
                actionEl,
                sessionEl,
                sessionId: sessionEl?.dataset.sessionId || '',
                nodeId: nodeEl?.dataset.historyId || nodeEl?.dataset.id || sessionEl?.dataset.sessionId || '',
            };

            const handler = this.actionMap.get(action);
            if (handler) {
                handler(ctx);
            } else {
                console.warn(`[EventDispatcher] Unknown action: ${action}`);
            }
        }) as EventListener);
    }

    // ================================================================
    // Agent 图标点击 — 导航到 Agent 编辑器
    // ================================================================

    /**
     * 处理 agent 图标点击，通过全局导航事件跳转到 Agent 工作区
     * 
     * 使用 NavigationRequest 协议，不直接依赖 hostContext。
     * 通过 DOM CustomEvent 冒泡到顶层，由 main.ts 的全局监听器处理。
     */
    private handleAgentIconClick(agentId: string): void {
        // 'default' agent 没有独立配置文件，跳过
        if (agentId === 'default') return;

        const event = new CustomEvent('app:navigate', {
            bubbles: true,
            detail: {
                target: 'agents',
                action: 'open',
                resourceId: agentId,
            },
        });

        this.container.dispatchEvent(event);
    }

    // ================================================================
    // 编辑动作（需要多步协调）
    // ================================================================

    private handleEditAction(ctx: ActionContext): void {
        // User bubble 编辑
        const editor = this.renderer.getEditor(ctx.sessionId);
        if (editor && ctx.sessionEl) {
            const actionsEl = ctx.sessionEl.querySelector('.llm-ui-edit-actions') as HTMLElement;
            if (actionsEl) {
                this.edit.toggleUserEdit(ctx.sessionId, editor, actionsEl, ctx.sessionEl);
                return;
            }
        }

        // Node 编辑
        const nodeEditor = this.renderer.getEditor(ctx.nodeId);
        if (nodeEditor) {
            this.edit.toggleNodeEdit(ctx.nodeId, ctx.sessionId, nodeEditor, ctx.actionEl);
        }
    }

    private handleConfirmEdit(ctx: ActionContext, regenerate: boolean): void {
        const editor = this.renderer.getEditor(ctx.sessionId);
        if (editor && ctx.sessionEl) {
            const actionsEl = ctx.sessionEl.querySelector('.llm-ui-edit-actions') as HTMLElement;
            if (actionsEl) {
                this.edit.confirmEdit(ctx.sessionId, editor, actionsEl, ctx.sessionEl, regenerate);
            }
        }
    }

    private handleCancelEdit(ctx: ActionContext): void {
        const editor = this.renderer.getEditor(ctx.sessionId);
        if (editor && ctx.sessionEl) {
            const actionsEl = ctx.sessionEl.querySelector('.llm-ui-edit-actions') as HTMLElement;
            if (actionsEl) {
                this.edit.cancelEdit(ctx.sessionId, editor, actionsEl, ctx.sessionEl);
            }
        }
    }

    // ================================================================
    // 通用动作
    // ================================================================

    private async handleCopy(content: string, btn: HTMLElement): Promise<void> {
        try {
            await copyText(content);
            const orig = btn.innerHTML;
            btn.innerHTML = '✓';
            this.timers.setTimeout(() => { btn.innerHTML = orig; }, 1500);
        } catch (e) {
            console.error('Copy failed', e);
        }
    }

    private async handleDelete(nodeId: string, type: 'user' | 'assistant'): Promise<void> {
        let message = 'Delete this message?';
        if (type === 'user') {
            const count = this.countAssociatedResponses(nodeId);
            if (count > 0) message = `Delete this message and ${count} response(s)?`;
        }
        if (await showConfirmDialog(message)) {
            this.fireNodeAction('delete', nodeId);
        }
    }

    private countAssociatedResponses(userNodeId: string): number {
        const sessions = this.container.querySelectorAll('.llm-ui-session');
        let count = 0;
        let found = false;

        sessions.forEach(session => {
            const id = (session as HTMLElement).dataset.sessionId;
            if (id === userNodeId) { found = true; return; }
            if (found) {
                if (session.classList.contains('llm-ui-session--assistant')) {
                    count++;
                } else {
                    found = false;
                }
            }
        });
        return count;
    }

    private findLastRetryableId(): string | null {
        const all = Array.from(this.container.querySelectorAll('[data-session-id]'));
        if (all.length > 0) {
            return (all[all.length - 1] as HTMLElement).dataset.sessionId || null;
        }
        return null;
    }

    // ================================================================
    // 清理
    // ================================================================

    destroy(): void {
        this.events.cleanup();
        this.timers.destroy();
        this.actionMap.clear();
    }
}

// ================================================================
// 类型定义
// ================================================================

interface ActionContext {
    actionEl: HTMLElement;
    sessionEl: HTMLElement | null;
    sessionId: string;
    nodeId: string;
}

type ActionHandler = (ctx: ActionContext) => void;
