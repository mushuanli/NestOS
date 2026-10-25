// @file: llm-ui/services/StateService.ts

import type { ConversationUIState, ISessionRepository } from '@itookit/llm-session/contracts';
import type { ChatInputSettings } from '../domain/ports/IChatInputPresenter';
import type { UIState } from '../domain/types';
import { ErrorHandler } from '../utils/errorHandler';
import {persistOperations} from './OperationPersistence';
import {readInputDraft} from '../domain/input-draft';
import {readDraftFiles} from './DraftFilesCodec';
import {validDraftToken} from '../domain/draft-file-identity';

/**
 * UI 状态持久化服务
 * 职责：UI 状态的保存和加载
 */
export class StateService {
    constructor(private engine: ISessionRepository) { }

    saveOperations(sessionId: string, records: readonly import('@itookit/llm-ui').OperationRecord[]): Promise<readonly import('@itookit/llm-ui').OperationRecord[]> {
        return persistOperations(this.engine, sessionId, records);
    }

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
            if (/^(?:CALL_INPUT_DRAFT_|DRAFT_)/.test(String((e as {code?: unknown})?.code))) throw e;
            console.warn('[StateService] Failed to load UI state:', e);
            return null;
        }
    }
}

function toConversationState(state: UIState, branch: string): ConversationUIState {
    return {
        collapseStates: state.collapse_states,
        historyVisibility: state.history_visibility,
        ...(state.input_text !== undefined ? {branchDrafts: {[branch]: {inputText: state.input_text, inputAgentId: state.input_agent_id,
            ...(state.input_token !== undefined ? {inputToken: readToken(state.input_token)} : {}),
            ...(state.input_files !== undefined ? {inputFiles: JSON.parse(JSON.stringify(readDraftFiles(state.input_files)))} : {}),
            inputTarget: state.input_target, ...(state.input_arguments ? {inputArguments: JSON.parse(JSON.stringify(state.input_arguments))} : {})}}} : {}),
    };
}

export function fromConversationState(state: ConversationUIState, branch: string): UIState {
    return {
        collapse_states: state.collapseStates ?? {},
        history_visibility: state.historyVisibility,
        input_text: state.branchDrafts?.[branch]?.inputText,
        input_token: readToken(state.branchDrafts?.[branch]?.inputToken),
        input_files: state.branchDrafts?.[branch]?.inputFiles === undefined ? undefined : readDraftFiles(state.branchDrafts[branch].inputFiles),
        input_agent_id: state.branchDrafts?.[branch]?.inputAgentId,
        input_target: state.branchDrafts?.[branch]?.inputTarget,
        input_arguments: readInputDraft(state.branchDrafts?.[branch]?.inputArguments),
        operations: state.operationRecords as unknown as UIState['operations'],
    };
}
function readToken(value: unknown): string | undefined {
    if (value === undefined || validDraftToken(value)) return value;
    throw Object.assign(new Error('Invalid persisted input identity'), {code: 'DRAFT_IDENTITY_INVALID'});
}
