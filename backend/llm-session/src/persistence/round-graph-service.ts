// @file: llm-conversation/src/persistence/round-graph-service.ts
// RoundGraphService — single entry point for all Round DAG structural mutations.
//
// Phase 1 (WP-02): Consolidates append, fork, ref move, delete, and
// branch creation into one validated service. RoundLog delegates
// structural operations here and focuses on the ILog contract (fold, draft).

import type { Round, RoundId, Ref, RoundResult, ExecutionRef } from '../contracts';
import type { ChatMessage } from '@itookit/llm-context';
import type { ContextProfileId } from '@itookit/llm-context';
import type { RoundManifest, PersistedRound, BranchMeta } from './round-types';
import type { RoundLogEvent, RoundChangeSet } from './round-events';
import { ulid } from './ulid';
import { roundToProjection } from './round-log';
import { toolCallsFromResult, roundStatusToNodeStatus } from './projection';
import type { ISessionRepository } from './types';
import { readRoundDocument } from './history-chain';

// ─── Error types ───────────────────────────────────────────────────────────

export class RoundGraphError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'RoundGraphError';
    }
}

// ─── RoundGraphService ─────────────────────────────────────────────────────

export class RoundGraphService {
    private static readonly writeTails = new Map<string, Promise<void>>();
    private onEvent?: (event: RoundLogEvent) => void;

    constructor(
        private readonly engine: ISessionRepository,
        private readonly sessionId: string,
    ) {}


    setEventListener(fn: (event: RoundLogEvent) => void): void {
        this.onEvent = fn;
    }

    // ── Manifest ───────────────────────────────────────────────────────────

    /** Load manifest — returns empty structure for new sessions (no phantom root). */
    async loadManifest(): Promise<RoundManifest> {
        const raw = await this.engine.getManifest(this.sessionId) as unknown as Record<string, unknown>;
        if (raw?.children && 'rootRoundId' in raw) {
            return {
                schemaVersion: 3,
                rootRoundId: (raw.rootRoundId as RoundId) ?? null,
                branches: (raw.branches as Record<string, RoundId | null>) ?? { main: null },
                branchMeta: (raw.branchMeta as Record<string, BranchMeta>) ?? {},
                currentBranch: (raw.currentBranch as string) ?? 'main',
                currentHead: (raw.currentHead as RoundId) ?? null,
                children: (raw.children as Record<RoundId, RoundId[]>) ?? {},
            };
        }
        // Bootstrap: empty session — no phantom root.
        return {
            schemaVersion: 3,
            rootRoundId: null,
            branches: { main: null },
            branchMeta: {},
            currentBranch: 'main',
            currentHead: null,
            children: {},
        };
    }

    async saveManifest(manifest: RoundManifest): Promise<void> {
        await this.engine.updateManifest(this.sessionId, manifest);
    }

    // ── Append with validation ─────────────────────────────────────────────

    /**
     * Append a committed Round to the DAG.
     *
     * Validates:
     *   - No duplicate RoundId (committed rounds are immutable)
     *   - All parents reference existing round files
     *   - No self-parent (roundId cannot be in parents)
     *   - No phantom parents when session is not empty
     */
    async append(ref: Ref, round: Round, expectedHead?: RoundId | null): Promise<RoundId> {
        return this.withWrite(() => this.appendUnsafe(ref, round, expectedHead));
    }

    private async appendUnsafe(ref: Ref, round: Round, expectedHead?: RoundId | null): Promise<RoundId> {
        const roundId = round.id || ulid();
        const persisted: PersistedRound = { ...round, id: roundId };

        const before = await this.loadManifest();
        if (expectedHead !== undefined && (before.branches[ref] ?? null) !== expectedHead) {
            throw new RoundGraphError(
                `Branch head conflict for ${ref}: expected ${expectedHead ?? 'null'}, got ${before.branches[ref] ?? 'null'}`,
                'HEAD_CONFLICT',
            );
        }

        // ── Validation ──
        await this.validateAppend(roundId, round.historyParentIds);

        // Write round file first (self-healing order)
        await this.writeRound(roundId, persisted);

        const manifest = await this.loadManifest();
        manifest.branches[ref] = roundId;
        manifest.rootRoundId = manifest.rootRoundId ?? roundId;
        if (manifest.currentBranch === ref) manifest.currentHead = roundId;

        // Maintain children reverse-index
        for (const parentId of round.historyParentIds) {
            if (!manifest.children[parentId]) manifest.children[parentId] = [];
            if (!manifest.children[parentId].includes(roundId)) {
                manifest.children[parentId].push(roundId);
            }
        }

        await this.saveManifest(manifest);

        // Emit event
        if (this.onEvent) {
            this.onEvent({
                type: 'round:appended',
                ref,
                roundId,
                projection: roundToProjection(persisted, roundId),
            });
        }

        return roundId;
    }

    private async withWrite<T>(operation: () => Promise<T>): Promise<T> {
        const key = this.sessionId;
        const previous = RoundGraphService.writeTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        RoundGraphService.writeTails.set(key, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (RoundGraphService.writeTails.get(key) === tail) RoundGraphService.writeTails.delete(key);
        }
    }

    private async validateAppend(roundId: RoundId, parents: RoundId[]): Promise<void> {
        // No self-parent
        if (parents.includes(roundId)) {
            throw new RoundGraphError('Round cannot be its own parent', 'SELF_PARENT');
        }
        // No duplicate ID — committed rounds are immutable
        const existing = await this.readRound(roundId);
        if (existing) {
            throw new RoundGraphError(
                `Round ${roundId} already exists — committed rounds are immutable`,
                'DUPLICATE_ID',
            );
        }

        // All parents must exist (unless session is empty)
        if (parents.length > 0) {
            for (const parentId of parents) {
                const parent = await this.readRound(parentId);
                if (!parent) {
                    throw new RoundGraphError(
                        `Parent round not found: ${parentId}`,
                        'PARENT_NOT_FOUND',
                    );
                }
            }
        }
    }

    // ── Read / Write ───────────────────────────────────────────────────────

    async readRound(roundId: RoundId): Promise<PersistedRound | null> {
        return readRoundDocument(() => this.engine.readDocument(this.sessionId, `round-${roundId}.json`));
    }

    private async writeRound(roundId: RoundId, round: PersistedRound): Promise<void> {
        await this.engine.writeDocument(this.sessionId, `round-${roundId}.json`, JSON.stringify(round, null, 2));
    }

    // ── Fork — create sibling Round on a new branch ────────────────────────

    async forkUserRound(
        sourceRoundId: RoundId,
        options: { branchName?: Ref; createdFrom: 'regenerate' | 'manual' | 'edit' },
    ): Promise<{ branchName: Ref; sourceRoundId: RoundId; newRoundId: RoundId; commonHeadId?: RoundId }> {
        const source = await this.readRound(sourceRoundId);
        if (!source) throw new RoundGraphError(`Source round not found: ${sourceRoundId}`, 'NOT_FOUND');
        const userMessages = source.input.filter(m => m.role === 'user');
        if (userMessages.length === 0) throw new RoundGraphError(`Source round has no user message: ${sourceRoundId}`, 'NO_USER_MSG');

        const manifest = await this.loadManifest();
        const fromBranch = manifest.currentBranch;
        const commonHeadId = source.historyParentIds[0];
        let branchName = options.branchName;
        if (!branchName) {
            let n = Object.keys(manifest.branches).length;
            do { branchName = `branch-${n++}`; } while (manifest.branches[branchName] !== undefined);
        }
        if (manifest.branches[branchName] !== undefined) {
            throw new RoundGraphError(`Branch already exists: ${branchName}`, 'BRANCH_EXISTS');
        }

        const newRoundId = ulid();
        const copiedPayload = userMessages.map(message => ({
            ...message,
            ...(Array.isArray((message as any).attachments)
                ? { attachments: (message as any).attachments.map((a: any) => ({ ...a })) }
                : {}),
        } as ChatMessage));
        const newRound: PersistedRound = {
            id: newRoundId,
            sessionId: source.sessionId,
            historyParentIds: commonHeadId ? [commonHeadId] : [],
            input: copiedPayload,
            output: [],
            executions: [],
            status: 'pending',
            createdAt: Date.now(),
            origin: 'rebase',
            rebasedFrom: sourceRoundId,
        };
        await this.writeRound(newRoundId, newRound);

        // Update children index
        if (commonHeadId) {
            const children = manifest.children[commonHeadId] ?? (manifest.children[commonHeadId] = []);
            if (!children.includes(newRoundId)) children.push(newRoundId);
        }

        const meta: BranchMeta = {
            createdAt: Date.now(),
            createdFrom: options.createdFrom,
            forkedFromBranch: fromBranch,
            sourceRoundId,
            commonHeadId,
            branchRootRoundId: newRoundId,
            // Inherit context profile from parent branch (copy-on-write)
            contextProfile: manifest.branchMeta[fromBranch]?.contextProfile,
        };
        manifest.branches[branchName] = newRoundId;
        manifest.branchMeta[branchName] = meta;
        manifest.currentBranch = branchName;
        manifest.currentHead = newRoundId;
        await this.saveManifest(manifest);

        return { branchName, sourceRoundId, newRoundId, commonHeadId };
    }

    /** Create a branch at the source Round's primary parent without committing a partial Round. */
    async createBranchForReplacement(
        sourceRoundId: RoundId | null,
        newRootRoundId: RoundId,
        options: { branchName?: Ref; createdFrom: 'regenerate' | 'manual' | 'edit' },
    ): Promise<{ branchName: Ref; commonHeadId?: RoundId }> {
        const source = sourceRoundId ? await this.readRound(sourceRoundId) : null;
        if (sourceRoundId && !source) throw new RoundGraphError(`Source round not found: ${sourceRoundId}`, 'NOT_FOUND');
        const manifest = await this.loadManifest();
        const fromBranch = manifest.currentBranch;
        const commonHeadId = source?.historyParentIds[0];
        let branchName = options.branchName;
        if (!branchName) {
            let index = Object.keys(manifest.branches).length;
            do { branchName = `branch-${index++}`; } while (manifest.branches[branchName] !== undefined);
        }
        if (manifest.branches[branchName] !== undefined) {
            throw new RoundGraphError(`Branch already exists: ${branchName}`, 'BRANCH_EXISTS');
        }
        manifest.branches[branchName] = commonHeadId ?? null;
        manifest.branchMeta[branchName] = {
            createdAt: Date.now(),
            createdFrom: options.createdFrom,
            forkedFromBranch: fromBranch,
            sourceRoundId: sourceRoundId ?? undefined,
            commonHeadId,
            branchRootRoundId: newRootRoundId,
            contextProfile: manifest.branchMeta[fromBranch]?.contextProfile,
        };
        manifest.currentBranch = branchName;
        manifest.currentHead = commonHeadId ?? null;
        await this.saveManifest(manifest);
        return { branchName, commonHeadId };
    }

    // ── In-place mutations (SS3.3 whitelist) ───────────────────────────────

    /** Replace assistant/tool output in a Round without changing its ID or parents. */
    async setAssistantInRound(
        roundId: RoundId,
        update: { assistantMessages: ChatMessage[]; result?: RoundResult; agentId?: string },
    ): Promise<void> {
        const round = await this.readRound(roundId);
        if (!round) throw new RoundGraphError(`Round not found: ${roundId}`, 'NOT_FOUND');
        if (round._deleted) {
            throw new RoundGraphError(`Cannot update deleted Round: ${roundId}`, 'ROUND_DELETED');
        }
        const hasEffectiveAssistant = round.output.some(message => {
            if (message.role !== 'assistant') return false;
            const content = message.content as unknown;
            return typeof content === 'string'
                ? content.trim().length > 0
                : content != null && String(content).trim().length > 0;
        });
        if (hasEffectiveAssistant) {
            throw new RoundGraphError(
                `Cannot overwrite completed Round: ${roundId}`,
                'ROUND_ALREADY_COMPLETED',
            );
        }
        const updated: PersistedRound = {
            ...round,
            output: update.assistantMessages.map(message => ({ ...message })),
            status: 'completed',
            completedAt: Date.now(),
            ...(update.agentId ? { agentId: update.agentId } : {}),
            result: update.result,
        };
        await this.writeRound(roundId, updated);

        const assistant = update.assistantMessages.find(message => message.role === 'assistant');
        const changes: RoundChangeSet = {
            assistantContent: assistant && typeof assistant.content === 'string' ? assistant.content : '',
            thinking: assistant && typeof (assistant as any).thinking === 'string'
                ? (assistant as any).thinking
                : '',
            agentId: update.agentId,
            toolCalls: toolCallsFromResult(update.result),
            flowInteractions: update.result?.flowInteractions,
        };
        this.onEvent?.({ type: 'round:updated', roundId, changes });
    }

    /** Update only the conversation transaction lifecycle fields. */
    async setConversationStatus(
        roundId: RoundId,
        status: NonNullable<Round['status']>,
        error?: string,
        result?: RoundResult,
    ): Promise<void> {
        const round = await this.readRound(roundId);
        if (!round) throw new RoundGraphError(`Round not found: ${roundId}`, 'NOT_FOUND');
        const completedAt = isTerminalConversationStatus(status) ? Date.now() : undefined;
        // Cancellation is a terminal failure too: dropping its reason made a reloaded run show an
        // unexplained empty assistant bubble while the live transcript had shown the reason.
        const failure = status === 'failed' || status === 'cancelled' ? error : undefined;
        await this.writeRound(roundId, { ...round, status, completedAt, error: failure,
            // A failed Round keeps the Tool calls it managed to start, so a reloaded transcript can
            // still show which tool failed instead of dropping the node entirely.
            ...(result ? { result } : {}) });
        this.onEvent?.({
            type: 'round:updated',
            roundId,
            changes: { status: roundStatusToNodeStatus(status), error: failure, flowInteractions: result?.flowInteractions },
        });
    }

    /** Associate a new execution without changing conversation lineage. */
    async attachExecution(roundId: RoundId, execution: ExecutionRef): Promise<void> {
        const round = await this.readRound(roundId);
        if (!round) throw new RoundGraphError(`Round not found: ${roundId}`, 'NOT_FOUND');
        const executions = [...round.executions];
        if (!executions.some(item => item.taskId === execution.taskId)) executions.push(execution);
        await this.writeRound(roundId, { ...round, executions, status: 'running' });
        this.onEvent?.({ type: 'round:updated', roundId, changes: {} });
    }

    /** Remove assistant payload — used by delete-assistant and resend. */
    async clearAssistantInRound(roundId: RoundId): Promise<void> {
        const round = await this.readRound(roundId);
        if (!round) return;
        const updated: PersistedRound = {
            ...round,
            output: [],
            result: undefined,
            status: 'pending',
            completedAt: undefined,
        };
        await this.writeRound(roundId, updated);

        if (this.onEvent) {
            this.onEvent({ type: 'round:updated', roundId, changes: { assistantContent: '', thinking: '' } });
        }
    }

    /** Soft-delete a Round. */
    async deleteRound(roundId: RoundId): Promise<void> {
        const round = await this.readRound(roundId);
        if (!round) return;
        await this.writeRound(roundId, { ...round, _deleted: true });

        if (this.onEvent) {
            this.onEvent({ type: 'round:deleted', roundId });
        }
    }

    /** Mark a Round as stale. */
    async markStale(roundId: RoundId): Promise<void> {
        const round = await this.readRound(roundId);
        if (!round) return;
        await this.writeRound(roundId, { ...round, stale: true });

        if (this.onEvent) {
            this.onEvent({ type: 'round:updated', roundId, changes: { stale: true } });
        }
    }

    // ── Ref operations ─────────────────────────────────────────────────────

    async createRef(name: string, at: RoundId): Promise<Ref> {
        const manifest = await this.loadManifest();
        if (manifest.branches[name] !== undefined) {
            throw new RoundGraphError(`Branch already exists: ${name}`, 'BRANCH_EXISTS');
        }
        manifest.branches[name] = at;
        await this.saveManifest(manifest);
        return name;
    }

    async moveRef(ref: Ref, to: RoundId): Promise<void> {
        const manifest = await this.loadManifest();
        if (manifest.branches[ref] === undefined) {
            throw new RoundGraphError(`Branch not found: ${ref}`, 'NOT_FOUND');
        }
        manifest.branches[ref] = to;
        if (manifest.currentBranch === ref) manifest.currentHead = to;
        await this.saveManifest(manifest);
    }

    async deleteRef(ref: Ref): Promise<void> {
        if (ref === 'main') {
            throw new RoundGraphError('Cannot delete the main branch', 'PROTECTED_REF');
        }
        const manifest = await this.loadManifest();
        if (manifest.branches[ref] === undefined) {
            throw new RoundGraphError(`Branch not found: ${ref}`, 'NOT_FOUND');
        }
        delete manifest.branches[ref];
        delete manifest.branchMeta[ref];
        if (manifest.currentBranch === ref) {
            manifest.currentBranch = 'main';
            manifest.currentHead = manifest.branches['main'] ?? null;
        }
        await this.saveManifest(manifest);
    }

    async listRefs(): Promise<Ref[]> {
        const manifest = await this.loadManifest();
        return Object.keys(manifest.branches);
    }

    async renameRef(oldName: string, newName: string): Promise<void> {
        const manifest = await this.loadManifest();
        if (manifest.branches[oldName] === undefined) {
            throw new RoundGraphError(`Branch not found: ${oldName}`, 'NOT_FOUND');
        }
        if (manifest.branches[newName] !== undefined) {
            throw new RoundGraphError(`Branch already exists: ${newName}`, 'BRANCH_EXISTS');
        }
        manifest.branches[newName] = manifest.branches[oldName];
        manifest.branchMeta[newName] = manifest.branchMeta[oldName];
        delete manifest.branches[oldName];
        delete manifest.branchMeta[oldName];
        if (manifest.currentBranch === oldName) manifest.currentBranch = newName;
        await this.saveManifest(manifest);
    }

    // ── Context profile ────────────────────────────────────────────────────

    /** Update the context profile pointer for a branch. */
    async setContextProfile(
        ref: Ref,
        profileId: ContextProfileId,
        revision: number,
        expectedRevision?: number,
    ): Promise<void> {
        const manifest = await this.loadManifest();
        if (manifest.branches[ref] === undefined) {
            throw new RoundGraphError(`Branch not found: ${ref}`, 'NOT_FOUND');
        }
        if (!manifest.branchMeta[ref]) {
            manifest.branchMeta[ref] = {
                createdAt: Date.now(),
                createdFrom: 'manual',
                forkedFromBranch: ref,
                sourceRoundId: manifest.branches[ref] ?? '',
                branchRootRoundId: manifest.branches[ref] ?? '',
            };
        }
        const currentRevision = manifest.branchMeta[ref].contextProfile?.revision;
        if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
            throw new RoundGraphError(
                `Context profile pointer conflict for ${ref}: expected r${expectedRevision}, got r${currentRevision ?? 0}`,
                'PROFILE_CONFLICT',
            );
        }
        manifest.branchMeta[ref].contextProfile = { id: profileId, revision };
        await this.saveManifest(manifest);
    }

    // ── Sibling lookup ─────────────────────────────────────────────────────

    async getSiblingRoundIds(roundId: RoundId): Promise<RoundId[]> {
        const round = await this.readRound(roundId);
        if (!round) return [];
        const manifest = await this.loadManifest();
        const parentId = round.historyParentIds[0];
        const ids = parentId ? (manifest.children[parentId] ?? []) : [roundId];
        const rounds = await Promise.all(ids.map(id => this.readRound(id)));
        return ids
            .filter((_, i) => rounds[i] && !rounds[i]!._deleted)
            .sort((a, b) => {
                const ra = rounds[ids.indexOf(a)];
                const rb = rounds[ids.indexOf(b)];
                return (ra?.createdAt ?? 0) - (rb?.createdAt ?? 0) || a.localeCompare(b);
            });
    }
}

function isTerminalConversationStatus(status: NonNullable<Round['status']>): boolean {
    return status === 'completed'
        || status === 'failed'
        || status === 'cancelled';
}
