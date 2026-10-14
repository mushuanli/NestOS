// @file: llm-conversation/session/session-state.ts
//
// In-memory session projection cache (Round DAG format).
// Updated via apply(RoundLogEvent); consumed by UI via getSessions().

import type { RoundId } from '../contracts';
import type { RoundProjection } from '../persistence/round-types';
import type { RoundLogEvent } from '../persistence/round-events';
import { buildToolChildren, buildFlowChildren } from '../persistence/projection';
import { NodeStatus } from '../core/types';
import {
    SessionGroup,
    ExecutionNode,
    ChatAttachment,
    SessionOrigin,
    HistoryPolicy,
} from '../core/types';
import type { SessionEvent } from '../core/types';

export interface HistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    files?: ChatAttachment[];
}

export class SessionState {
    private transientGroups: SessionGroup[] = [];
    private rounds: RoundProjection[] = [];
    private roundById = new Map<RoundId, RoundProjection>();
    /** Reverse index: parentRoundId → childRoundIds. Maintained incrementally. */
    private childrenByParent = new Map<RoundId, RoundId[]>();

    constructor(
        private readonly _sessionId: string,
    ) {}

    // ================================================================
    // 访问器
    // ================================================================

    get sessionId(): string { return this._sessionId; }



    getSessions(): SessionGroup[] {
        return [
            ...this.roundProjectionsToSessionGroups(),
            ...this.transientGroups,
        ];
    }

    getLastSession(): SessionGroup | undefined {
        const all = this.getSessions();
        return all[all.length - 1];
    }

    findSessionById(id: string): SessionGroup | undefined {
        return this.getSessions().find(s => s.id === id);
    }

    // ================================================================
    // Round format: single mutation entry
    // ================================================================

    /**
     * Apply a RoundLogEvent to the in-memory projection.
     * Returns SessionEvent[] to be emitted by the caller.
     */
    apply(event: RoundLogEvent): SessionEvent[] {

        switch (event.type) {
            case 'round:appended': return this.applyAppended(event);
            case 'round:updated': return this.applyUpdated(event);
            case 'round:deleted': return this.applyDeleted(event);
        }
    }

    private applyAppended(event: RoundLogEvent & { type: 'round:appended' }): SessionEvent[] {
        const { roundId, projection } = event;
        if (this.roundById.has(roundId)) return [];

        // Transient groups are the execution-time placeholders already rendered
        // to the UI via message:appended (createAssistantNode / createUserMessage).
        // When the persisted Round is later projected, the same bubbles would be
        // emitted again — the UI would render a duplicate node. Skip the re-emit
        // and only replace the state so future getSessions() reads the projection.
        const hadTransient = this.transientGroups.some(group => group.persistedNodeId === roundId);
        this.transientGroups = this.transientGroups
            .filter(group => group.persistedNodeId !== roundId);
        this.rounds.push(projection);
        this.roundById.set(roundId, projection);

        // Maintain childrenByParent reverse index
        for (const parentId of projection.historyParentIds) {
            if (!this.childrenByParent.has(parentId)) {
                this.childrenByParent.set(parentId, []);
            }
            const children = this.childrenByParent.get(parentId)!;
            if (!children.includes(roundId)) children.push(roundId);
        }

        if (hadTransient) return [];

        const sessionGroups = this.roundProjectionToSessionGroups(projection);
        const isExecutionRoot = projection.kind === 'chat' && !!projection.assistantMessage;
        const parentId = projection.historyParentIds.at(-1);

        // Emit one message:appended per SessionGroup produced by this round.
        // A chat round with both user and assistant emits two events so both bubbles appear.
        const events: SessionEvent[] = [];
        let prevId: string | undefined = parentId;
        for (const sessionGroup of sessionGroups) {
            events.push({
                type: 'message:appended',
                payload: {
                    sessionGroup,
                    isExecutionRoot: isExecutionRoot && sessionGroup.role === 'assistant',
                    parentId: prevId,
                },
            });
            prevId = sessionGroup.id;
        }
        return events;
    }

    private applyUpdated(event: RoundLogEvent & { type: 'round:updated' }): SessionEvent[] {
        const round = this.roundById.get(event.roundId);
        if (!round) return [];

        const { changes } = event;

        // Metadata updates must survive an empty assistant result; resend uses
        // the persisted agentId to avoid falling back to the default provider.
        if (changes.agentId !== undefined) round.agentId = changes.agentId;

        // Clear assistant: remove assistantMessage and notify UI
        if (changes.assistantContent !== undefined && !changes.assistantContent) {
            const assistantId = round.assistantMessage?.persistedNodeId;
            round.assistantMessage = undefined;
            const events: SessionEvent[] = [];
            if (assistantId) {
                events.push({
                    type: 'messages:deleted',
                    payload: { deletedIds: [assistantId] },
                });
            }
            return events;
        }

        // update-existing fills an assistant into a user-only Round. Keep the
        // projection authoritative after completion; previously it remained
        // user-only even though persistence contained the new assistant.
        if (!round.assistantMessage && changes.assistantContent) {
            round.assistantMessage = {
                content: changes.assistantContent,
                thinking: changes.thinking,
                status: changes.status ?? 'success',
                persistedNodeId: round.roundId,
                toolCalls: changes.toolCalls,
                flowInteractions: changes.flowInteractions,
            };
            const assistant = this.roundProjectionToSessionGroups(round)
                .find(group => group.role === 'assistant');
            return assistant ? [{
                type: 'message:appended',
                payload: {
                    sessionGroup: assistant,
                    isExecutionRoot: true,
                    parentId: round.userMessage?.persistedNodeId,
                },
            }] : [];
        }

        // A terminal failure with no assistant output must still materialize an
        // assistant bubble. Otherwise the transcript ends on the user message and
        // the next send is rejected as a consecutive user message, permanently
        // blocking the Session.
        // `Round.status` is `cancelled`, the node status is `aborted`; both need the placeholder
        // (the reload path uses the same predicate, so live and reloaded transcripts agree).
        const terminal = changes.status === 'failed' || changes.status === 'cancelled' || changes.status === 'aborted'
            ? changes.status
            : undefined;
        if (!round.assistantMessage
            && terminal
            && round.userMessage) {
            round.assistantMessage = {
                content: '',
                status: terminal === 'cancelled' ? 'aborted' : terminal,
                persistedNodeId: round.roundId,
                error: changes.error,
            };
            const assistant = this.roundProjectionToSessionGroups(round)
                .find(group => group.role === 'assistant');
            return assistant ? [{
                type: 'message:appended',
                payload: {
                    sessionGroup: assistant,
                    isExecutionRoot: true,
                    parentId: round.userMessage.persistedNodeId,
                },
            }] : [];
        }

        if (round.assistantMessage) {
            if (changes.flowInteractions !== undefined) round.assistantMessage.flowInteractions = changes.flowInteractions;
            if (changes.assistantContent !== undefined) {
                round.assistantMessage.content = changes.assistantContent;
            }
            if (changes.thinking !== undefined) {
                round.assistantMessage.thinking = changes.thinking;
            }
            if (changes.status !== undefined) {
                round.assistantMessage.status = changes.status;
            }
            if (changes.error !== undefined) {
                round.assistantMessage.error = changes.error;
            }
            if (changes.toolCalls !== undefined) {
                round.assistantMessage.toolCalls = changes.toolCalls;
            }
        }
        if (changes.stale !== undefined) round.stale = changes.stale;

        const events: SessionEvent[] = [];
        if (changes.status && round.assistantMessage) {
            events.push({
                type: 'message:status',
                payload: {
                    messageId: `round-${round.roundId}-assistant`,
                    status: changes.status,
                },
            });
        }
        return events;
    }

    private applyDeleted(event: RoundLogEvent & { type: 'round:deleted' }): SessionEvent[] {
        const cascadeIds = event.cascadeIds ?? this.collectCascadeRoundIds(event.roundId);
        const idSet = new Set(cascadeIds);

        this.rounds = this.rounds.filter(t => !idSet.has(t.roundId));
        for (const id of cascadeIds) {
            this.roundById.delete(id);
            this.childrenByParent.delete(id);
        }
        // Clean parent index entries
        for (const [parentId, children] of this.childrenByParent) {
            this.childrenByParent.set(parentId, children.filter(c => !idSet.has(c)));
        }

        return [{
            type: 'messages:deleted',
            payload: { deletedIds: cascadeIds },
        }];
    }

    /** Collect all RoundIds that should be cascade-deleted when this round is removed. */
    private collectCascadeRoundIds(roundId: RoundId): RoundId[] {
        const result = [roundId];
        const childIds = this.childrenByParent.get(roundId);
        if (childIds) {
            for (const childId of childIds) {
                result.push(...this.collectCascadeRoundIds(childId));
            }
        }
        return result;
    }

    // ================================================================
    // Round format: O(1) index-based lookups
    // ================================================================

    /** Get the first parent round of a given round. */
    getParentRound(roundId: RoundId): RoundProjection | undefined {
        const round = this.roundById.get(roundId);
        if (!round || round.historyParentIds.length === 0) return undefined;
        return this.roundById.get(round.historyParentIds[0]);
    }

    /**
     * Find the user-containing round before an assistant round.
     * Walks the parents chain until it finds a round carrying a userMessage.
     *
     * Accepts either a raw RoundId ("abc123") or a session group id
     * ("round-abc123-assistant"), matching how both callers (canRegenerate /
     * regenerate) pass an assistant message.
     */
    findUserRoundForAssistant(assistantId: RoundId): RoundProjection | undefined {
        const roundId = extractRoundId(assistantId);
        let current = this.roundById.get(roundId);
        while (current) {
            // A round that carries a user message is a valid source even when its
            // structural kind is not 'chat' (input[0] may be a system message).
            if (current.userMessage) return current;
            if (current.historyParentIds.length === 0) return undefined;
            current = this.roundById.get(current.historyParentIds[0]);
        }
        return undefined;
    }

    /** Diagnostic detail for an assistant message that cannot be regenerated. */
    describeRegenerateFailure(assistantId: RoundId): string {
        const roundId = extractRoundId(assistantId);
        const round = this.roundById.get(roundId);
        if (!round) {
            return `No user message found (round '${roundId}' is absent from the session projection — `
                + 'the bubble belongs to a run that never persisted, or the branch moved on)';
        }

        const chain: string[] = [];
        let current: RoundProjection | undefined = round;
        while (current) {
            chain.push(`${current.roundId}[kind=${current.kind}${current.userMessage ? ',has-user' : ',no-user'}]`);
            if (current.historyParentIds.length === 0) break;
            const parentId = current.historyParentIds[0];
            const parent = this.roundById.get(parentId);
            if (!parent) {
                chain.push(`missing-parent:${parentId}`);
                break;
            }
            current = parent;
        }
        return `No user message found (chain: ${chain.join(' -> ')})`;
    }

    /** Get child round IDs via the reverse index (O(1)). */
    getChildRoundIds(roundId: RoundId): RoundId[] {
        return this.childrenByParent.get(roundId) ?? [];
    }

    /** Diff support: check if a round is already in the projection. */
    hasRound(roundId: RoundId): boolean {
        return this.roundById.has(roundId);
    }

    /** Get all round projections (for diff computation). */
    getRounds(): RoundProjection[] {
        return this.rounds;
    }

    // ================================================================
    // 从持久化加载
    // ================================================================

    /** Load a RoundProjection into the round-format arrays. */
    loadFromProjection(projection: RoundProjection): void {
        this.rounds.push(projection);
        this.roundById.set(projection.roundId, projection);
        for (const parentId of projection.historyParentIds) {
            if (!this.childrenByParent.has(parentId)) {
                this.childrenByParent.set(parentId, []);
            }
            const children = this.childrenByParent.get(parentId)!;
            if (!children.includes(projection.roundId)) children.push(projection.roundId);
        }
    }

    addPendingUserMessage(
        text: string,
        files: ChatAttachment[],
        roundId: string,
        origin?: SessionOrigin,
        historyPolicy?: HistoryPolicy,
    ): SessionGroup {
        const session: SessionGroup = {
            id: `round-${roundId}-user`,
            persistedNodeId: roundId,
            role: 'user',
            content: text,
            files,
            timestamp: Date.now(),
            origin: origin ?? 'user',
            historyPolicy: historyPolicy ?? 'include',
        };
        this.transientGroups.push(session);
        return session;
    }

    addPendingAssistantMessage(group: SessionGroup): void {
        this.transientGroups.push(group);
    }

    updateMessageContent(messageId: string, newContent: string): void {
        const all = this.getSessions();
        const session = all.find(s => s.id === messageId);
        if (session) session.content = newContent;
    }

    appendToNode(nodeId: string, chunk: string, field: 'thought' | 'output'): void {
        for (const session of this.getSessions()) {
            if (session.executionRoot) {
                const node = this.findNodeInTree(session.executionRoot, nodeId);
                if (node) {
                    if (field === 'thought') {
                        node.data.thought = (node.data.thought || '') + chunk;
                    } else {
                        node.data.output = (node.data.output || '') + chunk;
                    }
                    return;
                }
            }
        }
    }

    updateNodeMeta(nodeId: string, metaInfo: Record<string, unknown>): void {
        for (const session of this.getSessions()) {
            if (!session.executionRoot) continue;
            const node = this.findNodeInTree(session.executionRoot, nodeId);
            if (node) { node.data.metaInfo = { ...node.data.metaInfo, ...metaInfo }; return; }
        }
    }

    updateNodeThought(nodeId: string, content: string): void {
        for (const session of this.getSessions()) {
            if (!session.executionRoot) continue;
            const node = this.findNodeInTree(session.executionRoot, nodeId);
            if (node) { node.data.thought = content; return; }
        }
    }

    updateNodeOutput(nodeId: string, content: string): void {
        for (const session of this.getSessions()) {
            if (session.executionRoot) {
                const node = this.findNodeInTree(session.executionRoot, nodeId);
                if (node) { node.data.output = content; return; }
            }
        }
    }

    updateNodeStatus(nodeId: string, status: NodeStatus): void {
        for (const session of this.getSessions()) {
            if (session.executionRoot) {
                const node = this.findNodeInTree(session.executionRoot, nodeId);
                if (node) { node.status = status; return; }
            }
        }
    }

    updateNodeError(nodeId: string, error: string): void {
        for (const session of this.getSessions()) {
            if (session.executionRoot) {
                const node = this.findNodeInTree(session.executionRoot, nodeId);
                if (node) { node.data.error = error; return; }
            }
        }
    }

    /** True when a node with the given id exists in any execution tree. */
    hasNode(nodeId: string): boolean {
        for (const session of this.getSessions()) {
            if (session.executionRoot && this.findNodeInTree(session.executionRoot, nodeId)) return true;
        }
        return false;
    }

    /**
     * Append a child node (e.g. a tool invocation) to an existing execution-tree
     * node. Idempotent: a node with the same id is never added twice.
     */
    appendChildNode(parentId: string, node: ExecutionNode): void {
        for (const session of this.getSessions()) {
            if (!session.executionRoot) continue;
            const parent = this.findNodeInTree(session.executionRoot, parentId);
            if (!parent) continue;
            if (!parent.children) parent.children = [];
            if (!parent.children.some(child => child.id === node.id)) parent.children.push(node);
            return;
        }
    }

    removeTransientMessages(messageIds: string[]): void {
        const idSet = new Set(messageIds);
        this.transientGroups = this.transientGroups.filter(s => !idSet.has(s.id));
    }

    /**
     * Drop transient (execution-time) groups whose round is not in the given
     * head chain. Used when switching branches: a transient assistant created on
     * the previous branch must disappear once the head moves elsewhere.
     *
     * @returns session ids of the removed groups, for the caller to emit
     *          messages:deleted so the UI unmounts those bubbles.
     */
    retainTransientForRounds(roundIds: Set<string>): string[] {
        const removed: string[] = [];
        this.transientGroups = this.transientGroups.filter(group => {
            if (group.persistedNodeId && roundIds.has(group.persistedNodeId)) return true;
            removed.push(group.id);
            return false;
        });
        return removed;
    }

    // ================================================================
    // 历史 (unified: works against getSessions())
    // ================================================================

    getHistory(): HistoryMessage[] {
        const history: HistoryMessage[] = [];
        for (const session of this.getSessions()) {
            if (session.historyPolicy === 'exclude') continue;
            if (session.role === 'user') {
                history.push({
                    role: 'user',
                    content: session.content || '',
                    files: session.files,
                });
            } else if (session.role === 'assistant' && session.executionRoot) {
                const output = this.extractOutput(session.executionRoot);
                if (output.trim()) {
                    history.push({ role: 'assistant', content: output });
                }
            }
        }
        return history;
    }

    // ================================================================
    // 导出 (unified: works against getSessions())
    // ================================================================

    exportToMarkdown(): string {
        const lines: string[] = [];
        for (const session of this.getSessions()) {
            if (session.role === 'user') {
                lines.push(`## User\n\n${session.content || ''}\n`);
            } else if (session.role === 'assistant' && session.executionRoot) {
                const output = this.extractOutput(session.executionRoot);
                const name = session.executionRoot.name || 'Assistant';
                lines.push(`## ${name}\n\n${output}\n`);
            }
        }
        return lines.join('\n---\n\n');
    }

    // ================================================================
    // 清理
    // ================================================================

    clear(): void {
        this.transientGroups = [];
        this.rounds = [];
        this.roundById.clear();
        this.childrenByParent.clear();
    }

    // ================================================================
    // ── RoundProjection → SessionGroup adapter ─────────────────────────
    // ================================================================

    /**
     * Converts one RoundProjection into 1 or 2 SessionGroups.
     * A chat round with both userMessage and assistantMessage produces:
     *   [SessionGroup(role:'user'), SessionGroup(role:'assistant')]
     * so that both bubbles appear in the UI on reload.
     */
    private roundProjectionToSessionGroups(p: RoundProjection): SessionGroup[] {
        const groups: SessionGroup[] = [];

        if (p.userMessage) {
            groups.push({
                id: `round-${p.roundId}-user`,
                persistedNodeId: p.userMessage.persistedNodeId,
                role: 'user',
                content: p.userMessage.content,
                files: p.userMessage.files,
                timestamp: p.createdAt,
                origin: p.origin as SessionOrigin,
                historyPolicy: (p.defaultContextMode === 'exclude' ? 'exclude' : 'include') as HistoryPolicy,
                roundId: p.roundId,
            });
        }

        if (p.assistantMessage) {
            groups.push({
                id: `round-${p.roundId}-assistant`,
                persistedNodeId: p.assistantMessage.persistedNodeId,
                role: 'assistant',
                content: p.assistantMessage.content,
                timestamp: p.createdAt,
                origin: p.origin as SessionOrigin,
                historyPolicy: (p.defaultContextMode === 'exclude' ? 'exclude' : 'include') as HistoryPolicy,
                roundId: p.roundId,
                executionRoot: {
                    id: `round-${p.roundId}-assistant`,
                    name: 'Assistant',
                    executorType: 'agent',
                    executorId: p.agentId ?? '',
                    status: p.assistantMessage.status,
                    startTime: p.createdAt,
                    parentId: undefined,
                    data: {
                        output: p.assistantMessage.content,
                        thought: p.assistantMessage.thinking ?? '',
                        error: p.assistantMessage.error,
                        metaInfo: p.agentId ? { agentId: p.agentId } : undefined,
                    },
                    children: [...buildToolChildren(p), ...buildFlowChildren(p)],
                },
            });
        }

        // System / merge rounds with no user or assistant message — return empty (not shown in UI)
        return groups;
    }

    private roundProjectionsToSessionGroups(): SessionGroup[] {
        return this.rounds.flatMap(t => this.roundProjectionToSessionGroups(t));
    }

    // ================================================================
    // 内部工具
    // ================================================================

    private findNodeInTree(node: ExecutionNode, targetId: string): ExecutionNode | null {
        if (node.id === targetId) return node;
        for (const child of node.children || []) {
            const found = this.findNodeInTree(child, targetId);
            if (found) return found;
        }
        return null;
    }

    private extractOutput(node: ExecutionNode): string {
        let output = node.data?.output || '';
        for (const child of node.children || []) {
            const childOutput = this.extractOutput(child);
            if (childOutput) output += '\n\n' + childOutput;
        }
        return output.trim();
    }
}

/**
 * Strip the session-group id prefix/suffix to get the underlying RoundId.
 * "round-abc123-assistant" → "abc123"; a raw RoundId passes through unchanged.
 */
function extractRoundId(id: string): string {
    const match = /^round-(.+)-(user|assistant)$/.exec(id);
    return match ? match[1] : id;
}
