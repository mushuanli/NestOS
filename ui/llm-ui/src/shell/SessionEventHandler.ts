// @file: llm-ui/shell/SessionEventHandler.ts



import { SessionCommand, type SessionEventEnvelope, type RegistryEvent, type SessionGroup } from '@itookit/llm-session/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import {t} from '@itookit/common';
import { Toast } from '@itookit/ui-common';

import type { IHistoryPresenter } from '../domain/ports/IHistoryPresenter';
import type { IStatusPresenter } from '../domain/ports/IStatusPresenter';
import type { IBranchPresenter } from '../domain/ports/IBranchPresenter';
import type { IChatInputPresenter } from '../domain/ports/IChatInputPresenter';
import type { IEditorEventBus } from '../domain/events';
import type { IBranchStore } from '../domain/ports/IBranchStore';

// ----------------------------------------------------------------
// 副作用声明表
// ----------------------------------------------------------------

type SideEffect =
    | 'renderFull' | 'refreshBranch' | 'refreshNav'
    | 'flashIndicator' | 'scrollToBottom' | 'clearErrors'
    | 'notifyChange' | 'resetCollapse';

/**
 * 集中声明式：事件 → 副作用映射
 *
 * 新增事件时只需在此表添加一行，不需要修改任何 if/switch 逻辑。
 * 符合 OCP：对扩展开放，对修改关闭。
 */
const EVENT_SIDE_EFFECTS: Partial<Record<string, SideEffect[]>> = {
    // 会话生命周期
    finished: ['clearErrors', 'notifyChange', 'refreshNav'],
    error: [],

    // ── LLM 2.0 canonical / projection event names (S7) ──
    'message:appended': ['clearErrors', 'notifyChange', 'scrollToBottom'],
    'messages:cleared': ['refreshNav', 'refreshBranch'],
    'messages:deleted': ['refreshNav', 'notifyChange'],
    'message:edited': ['refreshNav'],
    'sibling:switched': ['refreshBranch'],
    'branch:switched': ['refreshBranch', 'refreshNav', 'flashIndicator'],
    'log:appended': ['refreshBranch', 'flashIndicator'],
    'log:ref_moved': ['resetCollapse', 'refreshBranch', 'flashIndicator'],
    'log:ref_renamed': ['refreshBranch'],
    'log:ref_deleted': ['refreshBranch', 'refreshNav'],

    // 重新生成（保留 — 无 canonical 等价事件）
    regenerate_started: ['clearErrors', 'flashIndicator'],
    regenerate_completed: ['refreshBranch', 'refreshNav'],
};

// ----------------------------------------------------------------
// 依赖接口
// ----------------------------------------------------------------

export interface SessionEventHandlerDeps {
    commands: ICommandBus;
    historyView: IHistoryPresenter;
    bus: IEditorEventBus;
    branchIndicator: IBranchPresenter;
    statusIndicator: IStatusPresenter;
    /** ChatInput presenter — 用于更新 token 用量显示 */
    chatInput: IChatInputPresenter;
    branchStore: IBranchStore;
    getCurrentSessionId: () => string | null;
    onContentChanged: () => void;
    onNavRefresh: () => void;
    /**
     * 导航到指定会话（可选）。
     *
     * 当后台会话发出 session_tty_active 事件时，通知条提示用户点击切换。
     * 由 Shell 注入，不提供时仅展示无操作的 Toast。
     */
    onNavigateToSession?: (sessionId: string) => void;
    onExecutionTask?: (taskId: string) => void;
}

// ----------------------------------------------------------------
// 实现
// ----------------------------------------------------------------

export class SessionEventHandler {
    /** 副作用执行器表：每种副作用对应一个执行函数 */
    private readonly executors: Record<SideEffect, () => void>;

    constructor(private deps: SessionEventHandlerDeps) {
        // 一次性绑定，避免每次事件都创建闭包
        this.executors = {
            renderFull:     () => {
                this.deps.commands.execute<SessionGroup[]>(SessionCommand.GetSessions).then(sessions => {
                    this.deps.historyView.renderFull(sessions);
                }).catch(() => {});
            },
            refreshBranch:  () => this.deps.branchStore.refresh(),
            refreshNav:     () => this.deps.onNavRefresh(),
            flashIndicator: () => this.deps.branchIndicator.flash(),
            scrollToBottom: () => this.deps.historyView.scrollToBottom(true),
            clearErrors:    () => this.deps.historyView.clearErrors(),
            notifyChange:   () => this.deps.onContentChanged(),
            resetCollapse:  () => this.deps.historyView.resetCollapseStates(),
        };
    }

    // ================================================================
    // 会话事件入口
    // ================================================================

    handleSessionEvent(event: SessionEventEnvelope): void {
        // 1. 始终转发给 HistoryView 处理 DOM 级更新（流式内容、节点追加等）
        this.deps.historyView.processEvent(event);

        // 2. 状态指示器（需要 payload，单独处理）
        this.updateStatusFromEvent(event);

        // 3. 分支事件携带 payload 的特定处理
        this.handleBranchEvent(event);

        // 4. 查表执行副作用
        const effects = EVENT_SIDE_EFFECTS[event.type];
        if (effects) {
            const seen = new Set<SideEffect>();
            for (const effect of effects) {
                if (!seen.has(effect)) {
                    seen.add(effect);
                    this.executors[effect]();
                }
            }
        }
    }

    /**
     * 分支事件处理 — 需要事件 payload 的操作集中于此。
     * SessionEventBus 已在边界归一化为 { type, payload }，故直接按 event.type 收窄读取 event.payload。
     */
    private handleBranchEvent(event: SessionEventEnvelope): void {
        switch (event.type) {
            case 'branch:switched':
                this.deps.commands.execute<SessionGroup[]>(SessionCommand.GetSessions).then(sessions => {
                    this.deps.historyView.renderFull(sessions, {
                        position: event.payload.displayPosition === 'bottom' ? 'bottom' : 'top',
                    });
                }).catch(() => {});
                break;
            case 'messages:deleted':
                this.deps.historyView.removeMessages(event.payload.deletedIds, true);
                break;

            case 'log:ref_renamed': {
                const el2 = this.deps.historyView.getElement(event.payload.ref);
                if (el2) {
                    const nameEl2 = el2.querySelector('.llm-branch-name');
                    if (nameEl2) nameEl2.textContent = event.payload.newName;
                }
                break;
            }
        }
    }

    handleGlobalEvent(event: RegistryEvent): void {
        switch (event.type) {
            case 'session_status_changed':
                if (event.payload.sessionId === this.deps.getCurrentSessionId()) {
                    this.deps.statusIndicator.update(event.payload.status);
                } else if (event.payload.status === 'completed') {
                    Toast.info('Background task completed');
                }
                break;
            case 'session_tty_active':
                // Only notify when the TTY activity is in a background session.
                if (event.payload.sessionId !== this.deps.getCurrentSessionId()) {
                    const navigate = this.deps.onNavigateToSession;
                    const ttyMsg = t('session.ttyActive', { command: event.payload.command });
                    if (navigate) {
                        Toast.action(ttyMsg, t('session.ttyActive.switchView'), () => navigate(event.payload.sessionId));
                    } else {
                        Toast.info(ttyMsg);
                    }
                }
                break;
            case 'session_hitl_active':
                // Background session is waiting for human input — notify the user.
                if (event.payload.sessionId !== this.deps.getCurrentSessionId()) {
                    const navigate = this.deps.onNavigateToSession;
                    const question = event.payload.question.length > 50
                        ? `${event.payload.question.slice(0, 50)}\u2026`
                        : event.payload.question;
                    const hitlMsg = t('session.hitlActive', { question });
                    if (navigate) {
                        Toast.action(hitlMsg, t('session.hitlActive.switch'), () => navigate(event.payload.sessionId));
                    } else {
                        Toast.info(hitlMsg);
                    }
                }
                break;
            case 'execution_task_projected':
                if (event.payload.sessionId === this.deps.getCurrentSessionId()) {
                    this.deps.onExecutionTask?.(event.payload.taskId);
                }
                break;
        }
    }

    private updateStatusFromEvent(event: SessionEventEnvelope): void {
        if (event.type === 'finished') {
            this.deps.statusIndicator.update('completed');
            // `finished` 事件携带原始 TokenUsage（prompt_tokens/completion_tokens），
            // 映射为 TokenStats 的 input/output。cost/contextUsage/rounds/duration 需要
            // 额外上下文（模型窗口、累计轮次），属独立功能，暂不在此计算。
            const usage = event.payload.usage;
            this.deps.chatInput.updateTokenStats({
                inputTokens: usage.prompt_tokens ?? 0,
                outputTokens: usage.completion_tokens ?? 0,
                cacheReadTokens: typeof usage.cached_tokens === 'number' ? usage.cached_tokens : undefined,
                costUsd: 0,
                contextUsageRatio: 0,
                rounds: 0,
                durationMs: 0,
                isEstimated: false,
            });
        } else if (event.type === 'error') {
            this.deps.statusIndicator.update(event.payload.error?.code === 'ABORTED' ? 'aborted' : 'failed');
        }
    }
}
