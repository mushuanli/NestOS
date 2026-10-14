// @file: llm-ui/services/StateService.ts

import type { ConversationUIState, ISessionRepository } from '@itookit/llm-session/contracts';
import type { ChatInputSettings } from '../domain/ports/IChatInputPresenter';
import type { UIState } from '../domain/types';
import { ErrorHandler } from '../utils/errorHandler';

/**
 * UI 状态持久化服务
 * 职责：UI 状态的保存和加载
 */
export class StateService {
    constructor(private engine: ISessionRepository) { }

    /**
     * 保存 UI 状态
     */
    async saveUIState(sessionId: string, state: UIState, branch = 'main'): Promise<void> {
        try {
            await this.engine.updateUIState(sessionId, toConversationState(state, branch));
        } catch (e: unknown) {
            if (e instanceof Error && ErrorHandler.classifyError(e).userMessage === 'The requested resource was not found.') {
                return; // node deleted, ignore
            }
            console.warn('[StateService] Failed to save UI state:', e);
            throw e;
        }
    }

    async saveSessionSettings(sessionId: string, settings: ChatInputSettings): Promise<void> {
        await this.engine.saveSessionSettings(sessionId, settings);
    }

    /**
     * 加载 UI 状态
     */
    async loadUIState(sessionId: string, branch = 'main'): Promise<UIState | null> {
        try {
            const state = await this.engine.getUIState(sessionId);
            return state ? fromConversationState(state, branch) : null;
        } catch (e) {
            console.warn('[StateService] Failed to load UI state:', e);
            return null;
        }
    }
}

function toConversationState(state: UIState, branch: string): ConversationUIState {
    return {
        collapseStates: state.collapse_states,
        historyVisibility: state.history_visibility,
        ...(state.input_text !== undefined ? { branchDrafts: { [branch]: { inputText: state.input_text, inputAgentId: state.input_agent_id } } } : {}),
    };
}

export function fromConversationState(state: ConversationUIState, branch: string): UIState {
    return {
        collapse_states: state.collapseStates ?? {},
        history_visibility: state.historyVisibility,
        input_text: state.branchDrafts?.[branch]?.inputText,
        input_agent_id: state.branchDrafts?.[branch]?.inputAgentId,
    };
}
