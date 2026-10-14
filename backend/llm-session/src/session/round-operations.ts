// @file: llm-conversation/session/round-operations.ts

import {
    SessionGroup,
    SessionEvent,
    ChatAttachment,
    ExecutionOverrides,
    DeleteOptions,
    DeleteResult,
    BranchInfo,
    RegenerateOptions,
    RegenerateResult,
    RegenerateTrigger,
    SessionOrigin,
    HistoryPolicy,
} from '../core/types';
import type { SendIntent } from '@itookit/llm-flow/contracts';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import { SessionState } from './session-state';
import { SessionRegistry } from './session-registry';
import { SessionRunCoordinator } from './session-run-coordinator';
import { RoundLog } from '../persistence/round-log';
import type { PromptHistoryService } from '../services/prompt-history-service';
import type { SessionHost } from '../utils/host-ports';
import { ulid } from '../persistence/ulid';

/**
 * RoundOperations — all round/message mutation operations.
 *
 * Depends on SessionRegistry for conversation state and SessionRunCoordinator for execution.
 */
export class RoundOperations {
    private get host(): SessionHost { return this.registry.host; }
    private registry: SessionRegistry;
    private runs: SessionRunCoordinator;

    constructor(registry: SessionRegistry, runs: SessionRunCoordinator, private readonly promptHistory?: PromptHistoryService) {
        this.registry = registry;
        this.runs = runs;
    }

    // ================================================================
    // 发送消息
    // ================================================================

    async sendMessage(
        text: string,
        files: ChatAttachment[],
        agentId: string,
        overrides?: ExecutionOverrides,
        origin?: SessionOrigin,
        historyPolicy?: HistoryPolicy,
        sendIntent?: SendIntent,
    ): Promise<string> {
        const { sessionId, runtime, state } = this.registry.ensureBound();

        const lastSession = state.getLastSession();
        if (lastSession && lastSession.role === 'user') {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                'Cannot send consecutive user messages.'
            );
        }

        this.promptHistory?.add(text, { agentId, sessionId }).catch((e) => {
            this.host.logger.warn('Failed to record prompt history', { error: e });
        });

        return this.runs.submit(
            { sessionId, text, files, agentId, overrides, origin, historyPolicy, sendIntent },
            runtime
        );
    }

    abort(): void {
        if (this.registry.boundSessionId) {
            this.runs.abort(this.registry.boundSessionId);
        }
    }

    async setContextMode(
        roundIds: string[],
        mode: 'include' | 'exclude',
        scope: 'node' | 'subtree' = 'subtree',
    ): Promise<{ profileId: string; revision: number }> {
        const { sessionId } = this.registry.ensureBound();
        const log = new RoundLog(this.registry.engine, sessionId);
        const manifest = await log.loadManifest();
        return log.setRoundContextRules(manifest.currentBranch, roundIds, mode, scope);
    }

    async getContextModes(roundIds: string[]): Promise<Record<string, 'include' | 'exclude' | 'summary'>> {
        const { sessionId } = this.registry.ensureBound();
        const log = new RoundLog(this.registry.engine, sessionId);
        const manifest = await log.loadManifest();
        return log.getRoundContextModes(manifest.currentBranch, roundIds);
    }

    // ================================================================
    // 重新生成（统一入口）
    // ================================================================

    async regenerate(
        assistantId: string,
        options?: RegenerateOptions
    ): Promise<RegenerateResult> {
        const { state } = this.registry.ensureBound();
        this.registry.ensureNotGenerating('regenerate');

        const userRound = state.findUserRoundForAssistant(assistantId);
        if (!userRound?.userMessage) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                'No user message found before the specified assistant message'
            );
        }
        // Build the user SessionGroup directly from the projection. findSessionById
        // expects a session id ("round-X-user") but userMessage.persistedNodeId is a
        // raw RoundId ("X") — matching by session id would miss.
        const userMessage: SessionGroup = {
            id: `round-${userRound.roundId}-user`,
            persistedNodeId: userRound.userMessage.persistedNodeId,
            role: 'user',
            content: userRound.userMessage.content,
            files: userRound.userMessage.files,
            timestamp: userRound.createdAt,
            origin: userRound.origin as SessionOrigin,
            historyPolicy: (userRound.defaultContextMode === 'exclude' ? 'exclude' : 'include') as HistoryPolicy,
            roundId: userRound.roundId,
        };

        const currentAssistant = state.findSessionById(assistantId);
        const agentId = this.resolveAgentId(
            options?.agentId,
            currentAssistant?.executionRoot?.executorId
        );

        return this.executeRegenerate(userMessage, agentId, {
            sourceId: assistantId,
            trigger: 'from_assistant',
            overrides: options?.overrides,
        });
    }

    async regenerateFromUser(
        userMessageId: string,
        options?: RegenerateOptions
    ): Promise<RegenerateResult> {
        const { state } = this.registry.ensureBound();
        this.registry.ensureNotGenerating('regenerate');

        const userMessage = state.findSessionById(userMessageId);
        if (!userMessage || userMessage.role !== 'user') {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                `Invalid user message: ${userMessageId}`
            );
        }

        const sourceRound = state.getRounds().find(
            round => round.roundId === userMessage.persistedNodeId
        );
        const agentId = this.resolveAgentId(
            options?.agentId,
            sourceRound?.agentId
        );

        return this.executeRegenerate(userMessage, agentId, {
            sourceId: userMessageId,
            trigger: 'from_user',
            overrides: options?.overrides,
        });
    }

    // ================================================================
    // 重新生成：核心实现
    // ================================================================

    private async executeRegenerate(
        userMessage: SessionGroup,
        agentId: string,
        context: {
            sourceId: string;
            trigger: RegenerateTrigger;
            overrides?: ExecutionOverrides;
        }
    ): Promise<RegenerateResult> {
        const { sessionId, state, runtime } = this.registry.ensureBound();
        const eventBus = this.registry.eventBus;

        if (!userMessage.persistedNodeId) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                'User message not persisted, cannot create branch'
            );
        }

        const userRoundId = userMessage.persistedNodeId;

        // RoundLog branch: fork a new ref pointing to the parent of the user
        // round (i.e. above the user+assistant pair). This way fold() walking
        // the new branch skips the old assistant entirely.
        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const userRound = await roundLog.readRound(userRoundId);
        if (!userRound) throw new ConversationError(ConversationErrorCode.SESSION_INVALID, 'User Round not found');

        // The in-memory projection is updated immediately when the user
        // deletes an assistant. Prefer it over a possibly stale Round file;
        // otherwise resend can incorrectly see the old assistant on disk and
        // fork a new branch.
        const hasAssistant = hasRegenerateAssistant(state, userRound, userRoundId);
        const manifest = await roundLog.loadManifest();
        let branchName = manifest.currentBranch;
        let targetRoundId = userRoundId;
        let roundTarget: NonNullable<import('../core/types').TaskInput['roundTarget']> = {
            mode: 'update-existing',
            targetRoundId: userRoundId,
        };
        let branchCreated = false;
        if (hasAssistant) {
            // forkUserRound persists a fresh user Round on a new branch and points
            // currentHead at it. The head chain then resolves from the new user
            // Round back through the shared history, so the whole branch renders —
            // the regenerate's execution fills this Round's assistant in-place.
            const forked = await roundLog.forkUserRound(
                userRoundId,
                { createdFrom: 'regenerate' },
            );
            branchName = forked.branchName;
            targetRoundId = forked.newRoundId;
            roundTarget = {
                mode: 'update-existing',
                targetRoundId: forked.newRoundId,
            };
            branchCreated = true;
        }

        await this.registry.reloadSessionData(sessionId, state);

        const branchInfo = await this.getSiblingInfo(sessionId, targetRoundId);

        if (branchCreated) {
            eventBus.emitSession(sessionId, {
                type: 'branch:switched',
                payload: {
                    branchName,
                    headRoundId: targetRoundId,
                    branchRootRoundId: targetRoundId,
                    reason: 'regenerate',
                    displayPosition: 'top',
                },
            });
        }

        // 6. 发送事件
        eventBus.emitSession(sessionId, {
            type: 'regenerate_started',
            payload: {
                sourceId: context.sourceId,
                newUserNodeId: targetRoundId,
                branchName,
                agentId,
                trigger: context.trigger,
            },
        });

        // Empty/missing assistant: fill the existing Round. Effective assistant:
        // commit a replacement Round on the newly-created branch.
        await this.runs.submit(
            {
                sessionId,
                text: userMessage.content || '',
                files: userMessage.files || [],
                agentId,
                overrides: context.overrides,
                skipUserMessage: true,
                parentUserNodeId: targetRoundId,
                roundTarget,
                branchInfo,
                regenerateContext: {
                    sourceId: context.sourceId,
                    trigger: context.trigger,
                    branchName,
                },
            },
            runtime
        );

        return { branchName, userNodeId: targetRoundId, agentId, branchCreated };
    }

    // ================================================================
    // 消息操作：删除
    // ================================================================

    async deleteMessage(messageId: string, options?: DeleteOptions): Promise<DeleteResult> {
        const { sessionId, state } = this.registry.ensureBound();
        const idsToDelete = RoundOperations.collectDeletableIds(
            state, messageId, options?.deleteAssociatedResponses ?? true
        );
        return this.executeDelete(sessionId, state, idsToDelete, options);
    }

    async deleteMessages(messageIds: string[], options?: DeleteOptions): Promise<DeleteResult> {
        if (messageIds.length === 0) return { deletedIds: [], deletedBranches: [] };
        if (messageIds.length === 1) return this.deleteMessage(messageIds[0], options);

        const { sessionId, state } = this.registry.ensureBound();
        const allIds = new Set<string>();

        for (const id of messageIds) {
            RoundOperations.collectDeletableIds(
                state, id, options?.deleteAssociatedResponses ?? true
            ).forEach(x => allIds.add(x));
        }

        return this.executeDelete(sessionId, state, Array.from(allIds), options);
    }

    private async executeDelete(

        sessionId: string,
        state: SessionState,
        idsToDelete: string[],
        options?: DeleteOptions
    ): Promise<DeleteResult> {
        const eventBus = this.registry.eventBus;
        const result: DeleteResult = { deletedIds: [], deletedBranches: [] };
        if (idsToDelete.length === 0) return result;

        // RoundLog: soft-delete rounds or clear assistant only.
        // Assistant messages just clear the payload (keep user); user messages delete the entire round.
        const roundLog = new RoundLog(this.registry.engine, sessionId);
        for (const id of idsToDelete) {
            const session = state.findSessionById(id);
            const roundId = session?.persistedNodeId;
            if (!roundId) continue;
            try {
                if (session?.role === 'assistant') {
                    await roundLog.clearAssistantInRound(roundId);
                } else {
                    await roundLog.deleteRound(roundId);
                }
            } catch (e) {
                this.host.logger.warn('Failed to delete round', { sessionId, roundId, role: session?.role, error: e });
            }
        }

        // Apply deletion to in-memory state
        const allDeletedIds = new Set<string>();
        for (const id of idsToDelete) {
            const session = state.findSessionById(id);
            const roundId = session?.persistedNodeId;
            if (!roundId) continue;

            let events: SessionEvent[];
            if (session?.role === 'assistant') {
                events = state.apply({
                    type: 'round:updated',
                    roundId,
                    changes: { assistantContent: '', thinking: '' },
                });
            } else {
                events = state.apply({ type: 'round:deleted', roundId });
            }

            for (const e of events) {
                if (e.type === 'messages:deleted') {
                    (e.payload?.deletedIds as string[])?.forEach(d => allDeletedIds.add(d));
                }
                eventBus.emitSession(sessionId, e);
            }
        }
        state.removeTransientMessages(idsToDelete);
        result.deletedIds = [...idsToDelete, ...allDeletedIds];

        const shouldCleanup = options?.cleanupOrphanedBranches ?? true;
        if (shouldCleanup) {
            const orphaned = await this.findOrphanedBranches(roundLog);
            for (const branchName of orphaned) {
                try {
                    await roundLog.refs().delete(branchName);
                    result.deletedBranches.push(branchName);
                    this.host.logger.info('Orphaned branch cleaned up', { branchName });
                } catch (e) {
                    this.host.logger.warn('Failed to cleanup orphaned branch', { branchName, error: e });
                }
            }
        }

        eventBus.emitSession(sessionId, {
            type: 'messages:deleted',
            payload: { deletedIds: idsToDelete },
        });

        return result;
    }

    private async findOrphanedBranches(roundLog: RoundLog): Promise<string[]> {
        const orphaned: string[] = [];
        try {
            const manifest = await roundLog.loadManifest();
            const currentBranch = manifest.currentBranch;
            for (const branchName of Object.keys(manifest.branches)) {
                if (branchName === currentBranch || branchName === 'main') continue;
                try {
                    const messages = await roundLog.fold(branchName);
                    if (messages.length === 0) {
                        orphaned.push(branchName);
                    }
                } catch { orphaned.push(branchName); }
            }
        } catch (e) { this.host.logger.warn('Failed to check orphaned branches', { error: e }); }
        return orphaned;
    }

    static collectDeletableIds(state: SessionState, messageId: string, includeResponses: boolean): string[] {
        const ids: string[] = [messageId];
        if (!includeResponses) return ids;
        const session = state.findSessionById(messageId);
        if (!session || session.role !== 'user') return ids;
        ids.push(...state.getChildRoundIds(messageId));
        return ids;
    }

    // ================================================================
    // 编辑
    // ================================================================

    updateDraft(messageId: string, newContent: string): void {
        const sessionId = this.registry.boundSessionId;
        if (!sessionId) return;

        const state = this.registry.getSessionState(sessionId);
        if (!state) return;

        state.updateMessageContent(messageId, newContent);
    }

    async commitEdit(
        messageId: string,
        newContent: string,
        autoRerun: boolean = false
    ): Promise<void> {
        const { sessionId, state, runtime } = this.registry.ensureBound();
        this.registry.ensureNotGenerating('commit edit');
        const eventBus = this.registry.eventBus;

        const session = state.findSessionById(messageId);
        if (!session) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID, 'Message not found');
        }

        if (session.role !== 'user') {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                'Only user messages can be edited'
            );
        }

        const resolvedAgentId = autoRerun
            ? this.resolveAgentId(undefined, undefined)
            : 'default';

        // Update in-memory state (draft)
        state.updateMessageContent(messageId, newContent);

        // For RoundLog, rounds are immutable — editing forks a new branch.
        const userRoundId = session.persistedNodeId;
        let newPersistedNodeId: string | undefined;
        let editParentRoundId: string | undefined;

        if (autoRerun && userRoundId) {
            const roundLog = new RoundLog(this.registry.engine, sessionId);
            newPersistedNodeId = ulid();
            const replacement = await roundLog.createBranchForReplacement(
                userRoundId,
                newPersistedNodeId,
                { createdFrom: 'edit' },
            );
            editParentRoundId = replacement.commonHeadId;
        }

        await this.registry.reloadSessionData(sessionId, state);

        eventBus.emitSession(sessionId, {
            type: 'message:edited',
            payload: {
                messageId,
                newContent,
                newPersistedNodeId,
            },
        });

        if (autoRerun && newPersistedNodeId) {
            const branchInfo = await this.getSiblingInfo(sessionId, newPersistedNodeId);
            const roundLog2 = new RoundLog(this.registry.engine, sessionId);
            const m2 = await roundLog2.loadManifest();
            const branchName = m2.currentBranch;

            eventBus.emitSession(sessionId, {
                type: 'branch:switched',
                payload: {
                    branchName,
                    headRoundId: m2.currentHead ?? newPersistedNodeId,
                    branchRootRoundId: newPersistedNodeId,
                    reason: 'create',
                    displayPosition: 'top',
                },
            });

            eventBus.emitSession(sessionId, {
                type: 'regenerate_started',
                payload: {
                    sourceId: messageId,
                    newUserNodeId: newPersistedNodeId,
                    branchName,
                    agentId: resolvedAgentId,
                    trigger: 'from_edit',
                },
            });

            await this.runs.submit(
                {
                    sessionId,
                    text: newContent,
                    files: session.files || [],
                    agentId: resolvedAgentId,
                    roundTarget: {
                        mode: 'append-new',
                        parentRoundId: editParentRoundId,
                        roundId: newPersistedNodeId,
                    },
                    branchInfo,
                    regenerateContext: {
                        sourceId: messageId,
                        trigger: 'from_edit',
                        branchName,
                    },
                },
                runtime
            );
        }
    }

    // ================================================================
    // 内部辅助
    // ================================================================

    private resolveAgentId(explicit?: string, fromContext?: string | null): string {
        if (explicit) return explicit;
        if (fromContext) return fromContext;
        return 'default';
    }

    private async getSiblingInfo(

        sessionId: string,
        roundId: string,
    ): Promise<BranchInfo> {
        const log = new RoundLog(this.registry.engine, sessionId);
        const siblings = await log.getSiblingRoundIds(roundId);
        const index = siblings.indexOf(roundId);
        if (index < 0) return { siblingIndex: 0, siblingCount: 1 };
        return { siblingIndex: index, siblingCount: siblings.length };
    }
}

/**
 * Decide whether a regenerate must fork a new branch (existing assistant) or
 * may fill the current Round (empty assistant).
 *
 * The in-memory projection wins when it shows a real assistant. Otherwise we
 * trust the persisted Round: the projection can lag behind disk because RoundLog
 * round:updated events are not wired into the in-memory state, so a completed
 * assistant may already exist on disk while the projection still shows an empty
 * round. Treating that as "no assistant" would attempt to overwrite a completed
 * Round and fail with ROUND_ALREADY_COMPLETED.
 */
export function hasRegenerateAssistant(
    state: SessionState,
    userRound: import('../persistence/round-types').PersistedRound,
    userRoundId: string,
): boolean {
    const projectedRound = state.getRounds().find(round => round.roundId === userRoundId);
    const projectedContent = projectedRound?.assistantMessage?.content;
    const projectedHasAssistant = projectedRound
        ? typeof projectedContent === 'string' && projectedContent.trim().length > 0
        : false;
    return projectedHasAssistant || RoundLog.hasEffectiveAssistant(userRound);
}

