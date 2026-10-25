// @file: llm-ui/services/StateService.ts

import type { ConversationUIState, ISessionRepository } from '@itookit/llm-session/contracts';
import type { ChatInputSettings } from '../domain/ports/IChatInputPresenter';
import type { UIState } from '../domain/types';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {DraftPersistence, readBranchDraft} from './DraftPersistence';
import {persistOperations} from './OperationPersistence';
import {readInputDraft} from '../domain/input-draft';
import {readInputContextDraft} from '../domain/context-draft';
import {readDraftFiles} from './DraftFilesCodec';
import {validDraftToken} from '../domain/draft-file-identity';

/**
 * UI 状态持久化服务
 * 职责：UI 状态的保存和加载
 */
export class StateService {
    private readonly drafts: DraftPersistence;
    constructor(private engine: ISessionRepository) {this.drafts = new DraftPersistence(engine);}
    observeDraft(sessionId: string, branch: string, state?: ConversationUIState): void {this.drafts.observe(sessionId, branch, state);}
    getDraftConflict(sessionId: string, branch: string) {return this.drafts.getConflict(sessionId, branch);}
    subscribeDraftConflicts(listener: () => void): () => void {return this.drafts.subscribe(listener);}
    async readDraftCandidate(sessionId: string, branch: string): Promise<{raw?: ConversationUIState; state: UIState | null}> {
        const raw = await this.engine.getUIState(sessionId) ?? undefined;
        readBranchDraft(raw, branch);
        return {raw, state: raw ? fromConversationState(raw, branch) : null};
    }

    saveOperations(sessionId: string, records: readonly import('@itookit/llm-ui').OperationRecord[]): Promise<readonly import('@itookit/llm-ui').OperationRecord[]> {
        return persistOperations(this.engine, sessionId, records);
    }

    /**
     * 保存 UI 状态
     */
    async saveUIState(sessionId: string, state: UIState, branch = 'main', replaceConflictId?: string): Promise<void> {
        const started = Date.now();
        try {
            const patch = toConversationState(state, branch);
            if (patch.branchDrafts) await this.drafts.save(sessionId, branch, patch, replaceConflictId);
            else await this.engine.updateUIState(sessionId, patch);
        } catch (error) {reportStateError('save', sessionId, started, error); throw error;}
    }

    async saveSessionSettings(sessionId: string, settings: ChatInputSettings): Promise<void> {
        await this.engine.saveSessionSettings(sessionId, settings);
    }

    /**
     * 加载 UI 状态
     */
    async loadUIState(sessionId: string, branch = 'main'): Promise<UIState | null> {
        const started = Date.now();
        try {
            const candidate = await this.readDraftCandidate(sessionId, branch);
            this.observeDraft(sessionId, branch, candidate.raw); return candidate.state;
        } catch (error) {reportStateError('load', sessionId, started, error); throw error;}
    }
}

function toConversationState(state: UIState, branch: string): ConversationUIState {
    return {
        collapseStates: state.collapse_states,
        historyVisibility: state.history_visibility,
        ...(state.input_text !== undefined ? {branchDrafts: {[branch]: {inputText: state.input_text, inputAgentId: state.input_agent_id,
            ...(state.input_token !== undefined ? {inputToken: readToken(state.input_token)} : {}),
            ...(state.input_files !== undefined ? {inputFiles: JSON.parse(JSON.stringify(readDraftFiles(state.input_files)))} : {}),
            inputTarget: state.input_target, ...(state.input_arguments ? {inputArguments: JSON.parse(JSON.stringify(state.input_arguments))} : {}),
            ...(state.input_context ? {inputContext: readInputContextDraft(state.input_context)} : {})}}} : {}),
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
        input_context: readInputContextDraft(state.branchDrafts?.[branch]?.inputContext),
        operations: state.operationRecords as unknown as UIState['operations'],
    };
}
function readToken(value: unknown): string | undefined {
    if (value === undefined || validDraftToken(value)) return value;
    throw Object.assign(new Error('Invalid persisted input identity'), {code: 'DRAFT_IDENTITY_INVALID'});
}

const stateLog = createModuleLogger('workspace-state');
function reportStateError(stage: string, sessionId: string, started: number, error: unknown): void {
    const raw = (error as {code?: unknown})?.code;
    try {stateLog.warn('Input state persistence', {operation: 'workspace.state', operationId: randomUUID(), sessionId, stage,
        result: 'failure', durationMs: Date.now() - started, code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'STATE_PERSISTENCE_FAILED'});}
    catch { /* Preserve the original storage or validation error. */ }
}
