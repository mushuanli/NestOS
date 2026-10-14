// @file: llm-ui/commands/CommandContext.ts

import type { ICommandBus, ISession } from '@itookit/llm-session/contracts';
import type { SessionGroup } from '@itookit/llm-session/contracts';
import type { IHistoryPresenter } from '../domain/ports/IHistoryPresenter';
import type { IChatInputPresenter } from '../domain/ports/IChatInputPresenter';
import type { IEditorEventBus } from '../domain/events';
import type { SessionService } from '../services/SessionService';
import type { StateService } from '../services/StateService';
import type { AssetService } from '../services/AssetService';
import type { ErrorHandler } from '../utils/errorHandler';

import type { BranchService } from '../services/BranchService';

/**
 * 命令上下文 — 全部面向接口
 *
 * 变更点：
 * - historyView: HistoryView → IHistoryPresenter
 * - chatInput: ChatInput → IChatInputPresenter
 * - bus: EditorEventBus → IEditorEventBus
 * - commands: ICommandBus (LLM 2.0 插件命令总线)
 * - session: ISession (Channel 原语 — signal + events)
 *
 * Command 完全不知道 UI 实现细节。
 */
export interface CommandContext {
    // 数据层
    /** 获取当前会话的所有消息投影 */
    getSessions: () => SessionGroup[];
    commands: ICommandBus;
    /** LLM 2.0: Channel 原语 — signal() 入向 + events() 出向 */
    session: ISession;
    sessionService: SessionService;
    stateService: StateService;
    assetService: AssetService;
    branchService: BranchService;

    // UI 接口（不是实现）
    historyView: IHistoryPresenter;
    chatInput: IChatInputPresenter;
    bus: IEditorEventBus;

    // 基础设施
    errorHandler: ErrorHandler;

    // 上下文
    getSessionId: () => string;
    /** Execute explicit user shell input through the host's existing process policy. */
    executeDirectCommand?: (command: string) => Promise<void>;
    resolveSubmission?: () => Promise<import('@itookit/llm-flow/contracts').SendIntent['submission']>;
}
