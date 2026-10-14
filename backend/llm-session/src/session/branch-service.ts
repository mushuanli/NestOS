// @file: llm-conversation/session/branch-service.ts

import { SessionGroup } from '../core/types';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import { BranchTreeNode } from '../persistence/types';
import { SessionRegistry } from './session-registry';
import type { SessionHost } from '../utils/host-ports';
import { RoundLog, roundToProjection } from '../persistence/round-log';
import { buildFlowChildren, buildToolChildren } from '../persistence/projection';
import type {
    PersistedRound,
    RoundManifest,
    RoundProjection,
} from '../persistence/round-types';

/**
 * BranchService — branch CRUD, sibling navigation, and branch message queries.
 *
 * Depends on SessionRegistry for ensureBound(), reloadSessionData(), and event emission.
 */
export class BranchService {
    private get host(): SessionHost { return this.registry.host; }
    private registry: SessionRegistry;

    constructor(registry: SessionRegistry) {
        this.registry = registry;
    }

    // ================================================================
    // 兄弟节点导航
    // ================================================================

    async switchToSibling(messageId: string, siblingIndex: number): Promise<void> {
        const { sessionId, state } = this.registry.ensureBound();
        this.registry.ensureNotGenerating('switch sibling');

        const session = state.findSessionById(messageId);
        if (!session?.persistedNodeId) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID, 'Message not found');
        }

        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const siblingIds = await roundLog.getSiblingRoundIds(session.persistedNodeId);
        if (siblingIndex < 0 || siblingIndex >= siblingIds.length) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID, 'Invalid sibling index');
        }
        const targetNodeId = siblingIds[siblingIndex];
        const manifest = await roundLog.loadManifest();
        const targetBranch = await this.findBranchForRound(roundLog, manifest, targetNodeId);
        if (!targetBranch) throw new ConversationError(ConversationErrorCode.SESSION_INVALID, 'Sibling is not reachable from a branch');
        manifest.currentBranch = targetBranch;
        manifest.currentHead = manifest.branches[targetBranch];
        await roundLog.saveManifest(manifest);

        await this.registry.reloadSessionData(sessionId, state);

        this.registry.eventBus.emitSession(sessionId, {
            type: 'sibling:switched',
            payload: { messageId, newIndex: siblingIndex, total: siblingIds.length },
        });
        this.registry.eventBus.emitSession(sessionId, {
            type: 'branch:switched',
            payload: {
                branchName: targetBranch,
                headRoundId: manifest.currentHead ?? '',
                branchRootRoundId: manifest.branchMeta[targetBranch]?.branchRootRoundId,
                reason: 'sibling-switch',
                displayPosition: 'top',
            },
        });
    }

    private async findBranchForRound(
        roundLog: RoundLog,
        manifest: Awaited<ReturnType<RoundLog['loadManifest']>>,
        targetRoundId: string,
    ): Promise<string | undefined> {
        for (const [name, head] of Object.entries(manifest.branches)) {
            let current: string | null | undefined = head;
            const visited = new Set<string>();
            while (current && !visited.has(current)) {
                if (current === targetRoundId) return name;
                visited.add(current);
                current = (await roundLog.readRound(current))?.historyParentIds[0];
            }
        }
        return undefined;
    }

    async getSiblings(messageId: string): Promise<SessionGroup[]> {
        const { sessionId, state } = this.registry.ensureBound();
        const session = state.findSessionById(messageId);
        if (!session?.persistedNodeId) return session ? [session] : [];

        try {
            const roundLog = new RoundLog(this.registry.engine, sessionId);
            const ids = await roundLog.getSiblingRoundIds(session.persistedNodeId);
            const count = ids.length;
            const result: SessionGroup[] = [];
            for (let index = 0; index < ids.length; index++) {
                const round = await roundLog.readRound(ids[index]);
                if (!round) continue;
                const projection = (await roundLog.getSiblingRounds(ids[index]))
                    .find(p => p.roundId === ids[index]);
                if (!projection) continue;
                if (projection.userMessage) result.push({
                    id: `round-${ids[index]}-user`, persistedNodeId: ids[index], role: 'user',
                    content: projection.userMessage.content, files: projection.userMessage.files,
                    timestamp: projection.createdAt, siblingIndex: index, siblingCount: count,
                });
                if (projection.assistantMessage) result.push({
                    id: `round-${ids[index]}-assistant`, persistedNodeId: ids[index], role: 'assistant',
                    content: projection.assistantMessage.content, timestamp: projection.createdAt,
                    siblingIndex: index, siblingCount: count,
                });
            }
            return result;
        } catch (e) {
            this.host.logger.error('getSiblings failed', { error: e });
            return session ? [session] : [];
        }
    }

    // ================================================================
    // 分支操作
    // ================================================================

    async createBranch(
        branchNodeId: string,
        options?: { name?: string; copyContent?: boolean }
    ): Promise<string> {
        const { sessionId, state } = this.registry.ensureBound();
        this.registry.ensureNotGenerating('create branch');
        const eventBus = this.registry.eventBus;

        const session = state.findSessionById(branchNodeId);
        if (!session?.persistedNodeId) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                `Message not found or not persisted: ${branchNodeId}`
            );
        }

        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const forked = await roundLog.forkUserRound(session.persistedNodeId, {
            branchName: options?.name,
            createdFrom: 'manual',
        });
        const newNodeId = forked.newRoundId;

        await this.registry.reloadSessionData(sessionId, state);

        eventBus.emitSession(sessionId, {
            type: 'branch:switched',
            payload: {
                branchName: forked.branchName,
                headRoundId: forked.newRoundId,
                branchRootRoundId: forked.newRoundId,
                reason: 'create',
                displayPosition: 'top',
            },
        });

        eventBus.emitSession(sessionId, {
            type: 'log:appended',
            ref: forked.branchName,
            roundId: newNodeId,
        });

        eventBus.emitSession(sessionId, {
            type: 'log:ref_created',
            ref: forked.branchName,
        });

        return newNodeId;
    }

    async switchBranch(branchName: string): Promise<void> {
        const { sessionId, state } = this.registry.ensureBound();
        const eventBus = this.registry.eventBus;
        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const manifest = await roundLog.loadManifest();
        if (!Object.prototype.hasOwnProperty.call(manifest.branches, branchName)) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                `Branch not found: ${branchName}`
            );
        }

        const currentBranch = manifest.currentBranch;
        if (currentBranch === branchName) return;
        this.registry.ensureNotGenerating('switch branch');

        const fromBranch = currentBranch;
        const previousHead = manifest.branches[fromBranch] ?? '';
        const newHead = manifest.branches[branchName] ?? null;
        manifest.currentBranch = branchName;
        manifest.currentHead = newHead;
        await roundLog.saveManifest(manifest);
        await this.registry.reloadSessionData(sessionId, state);

        eventBus.emitSession(sessionId, {
            type: 'branch:switched',
            payload: {
                branchName,
                headRoundId: manifest.currentHead ?? '',
                branchRootRoundId: manifest.branchMeta[branchName]?.branchRootRoundId,
                reason: 'manual-switch',
                displayPosition: 'top',
            },
        });

        eventBus.emitSession(sessionId, {
            type: 'log:ref_moved',
            ref: branchName,
            previousHead,
            newHead: newHead ?? '',
        });
    }

    async getBranchTree(): Promise<BranchTreeNode> {
        const { sessionId } = this.registry.ensureBound();
        const log = new RoundLog(this.registry.engine, sessionId);
        const manifest = await log.loadManifest();
        const rootId = manifest.rootRoundId;
        if (!rootId) return emptyBranchTree();
        const memberships = await collectBranchMemberships(log, manifest);
        const active = memberships.get(manifest.currentBranch) ?? new Set<string>();
        return buildBranchTree(log, manifest, rootId, memberships, active);
    }

    async renameBranch(oldName: string, newName: string): Promise<void> {
        const { sessionId } = this.registry.ensureBound();
        const roundLog = new RoundLog(this.registry.engine, sessionId);

        const manifest = await roundLog.loadManifest();
        if (manifest.branches[oldName] === undefined) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                `Branch not found: ${oldName}`
            );
        }

        const oldHead = manifest.branches[oldName];
        await roundLog.renameRef(oldName, newName);

        this.registry.eventBus.emitSession(sessionId, {
            type: 'log:ref_renamed',
            ref: oldHead ?? '',
            oldName,
            newName,
        });
    }

    async deleteBranch(branchName: string): Promise<void> {
        const { sessionId, state } = this.registry.ensureBound();
        this.registry.ensureNotGenerating('delete branch');
        const eventBus = this.registry.eventBus;
        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const manifest = await roundLog.loadManifest();
        if (Object.keys(manifest.branches).length <= 1) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_INVALID,
                'Cannot delete the last branch'
            );
        }
        if (manifest.branches[branchName] === undefined) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID, `Branch not found: ${branchName}`);
        }
        await roundLog.refs().delete(branchName);
        await this.registry.reloadSessionData(sessionId, state);
        eventBus.emitSession(sessionId, {
            type: 'log:ref_deleted',
            ref: branchName,
        });
    }

    async listBranches(): Promise<Array<{
        name: string;
        headNodeId: string;
        isCurrent: boolean;
    }>> {
        const { sessionId } = this.registry.ensureBound();
        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const manifest = await roundLog.loadManifest();

        return Object.entries(manifest.branches).map(([name, headNodeId]) => ({
            name,
            headNodeId: headNodeId ?? '',
            isCurrent: name === manifest.currentBranch,
        }));
    }

    async getBranchMessages(branchHeadNodeId: string): Promise<SessionGroup[]> {
        const { sessionId } = this.registry.ensureBound();
        const roundLog = new RoundLog(this.registry.engine, sessionId);
        const rounds = await collectRoundChain(roundLog, branchHeadNodeId);
        return rounds.flatMap(round => projectionGroups(roundToProjection(round, round.id)));
    }
}

async function collectRoundChain(log: RoundLog, headId: string): Promise<PersistedRound[]> {
    const rounds: PersistedRound[] = [];
    const visited = new Set<string>();
    let current: string | undefined = headId;
    while (current && !visited.has(current)) {
        visited.add(current);
        const round = await log.readRound(current);
        if (!round) break;
        if (!round._deleted) rounds.unshift(round);
        current = round.historyParentIds[0];
    }
    return rounds;
}

async function collectBranchMemberships(
    log: RoundLog,
    manifest: RoundManifest,
): Promise<Map<string, Set<string>>> {
    const memberships = new Map<string, Set<string>>();
    for (const [name, head] of Object.entries(manifest.branches)) {
        memberships.set(name, new Set((await collectRoundChain(log, head ?? '')).map(round => round.id)));
    }
    return memberships;
}

async function buildBranchTree(
    log: RoundLog,
    manifest: RoundManifest,
    roundId: string,
    memberships: Map<string, Set<string>>,
    active: Set<string>,
): Promise<BranchTreeNode> {
    const round = await log.readRound(roundId);
    if (!round) throw new Error(`Round not found: ${roundId}`);
    const childIds = manifest.children[roundId] ?? [];
    const children = await Promise.all(childIds.map(
        childId => buildBranchTree(log, manifest, childId, memberships, active),
    ));
    return branchTreeNode(round, memberships, active, children);
}

function branchTreeNode(
    round: PersistedRound,
    memberships: Map<string, Set<string>>,
    active: Set<string>,
    children: BranchTreeNode[],
): BranchTreeNode {
    const message = round.input.find(item => item.role === 'user')
        ?? round.output.find(item => item.role === 'assistant');
    return {
        id: round.id,
        role: message?.role === 'assistant' ? 'assistant' : 'user',
        content: typeof message?.content === 'string' ? message.content : '',
        timestamp: round.createdAt,
        isOnActivePath: active.has(round.id),
        memberOfBranches: [...memberships]
            .filter(([, ids]) => ids.has(round.id))
            .map(([name]) => name),
        children,
    };
}

function emptyBranchTree(): BranchTreeNode {
    return {
        id: '',
        role: 'system',
        content: '',
        timestamp: Date.now(),
        isOnActivePath: true,
        memberOfBranches: ['main'],
        children: [],
    };
}

/** Persisted Round → UI groups (pure); exported for the reload-consistency regression test. */
export function projectionGroups(projection: RoundProjection): SessionGroup[] {
    const groups: SessionGroup[] = [];
    if (projection.userMessage) groups.push(userGroup(projection));
    if (projection.assistantMessage) groups.push(assistantGroup(projection));
    return groups;
}

function userGroup(projection: RoundProjection): SessionGroup {
    return {
        id: `round-${projection.roundId}-user`,
        persistedNodeId: projection.roundId,
        role: 'user',
        content: projection.userMessage?.content ?? '',
        files: projection.userMessage?.files,
        timestamp: projection.createdAt,
        roundId: projection.roundId,
    };
}

function assistantGroup(projection: RoundProjection): SessionGroup {
    const message = projection.assistantMessage!;
    return {
        id: `round-${projection.roundId}-assistant`,
        persistedNodeId: projection.roundId,
        role: 'assistant',
        content: message.content,
        timestamp: projection.createdAt,
        roundId: projection.roundId,
        executionRoot: {
            id: message.persistedNodeId,
            executorId: projection.agentId ?? '',
            executorType: 'agent',
            name: 'Assistant',
            status: message.status,
            startTime: projection.createdAt,
            data: {
                output: message.content,
                thought: message.thinking ?? '',
                // Reloaded history must show the same terminal reason the live event stream did
                // (a cancelled/failed Round whose placeholder has no output).
                ...(message.error ? { error: message.error } : {}),
            },
            children: [...buildToolChildren(projection), ...buildFlowChildren(projection)],
        },
    };
}
