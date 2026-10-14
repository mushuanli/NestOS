import { foldContextHistory } from '@itookit/llm-context';
// @file: llm-conversation/src/persistence/round-log.ts
// RoundLog — native Round DAG ILog implementation.
//
// Each Round is stored as round-<roundId>.json inside the session's asset
// directory (flat, no sub-directory). The RoundManifest (stored in manifest.json) holds
// the DAG index and children reverse-index for O(1) sibling enumeration.
//
// The manifest owns the children reverse index. Round payloads are append-only
// except for explicit lifecycle and assistant-output updates.

import type { ILog, Round, RoundId, Ref, RefStore, AssemblyStrategy, RoundResult } from '../contracts';
import type { ChatMessage, ContextRule } from '@itookit/llm-context';
import type { ISessionRepository } from './types';
import type { RoundManifest, PersistedRound, RoundProjection } from './round-types';
import type { RoundLogEvent } from './round-events';
import { ulid } from './ulid';
import { RoundGraphService } from './round-graph-service';
import { ContextProfileStore } from './context-profile-store';
import { toolCallsFromResult, isFailedRoundStatus, roundStatusToNodeStatus } from './projection';

// ─── Fold cache ───────────────────────────────────────────────────────────

interface CacheEntry {
    messages: ChatMessage[];
    at: number;
}

class FoldCache {
    private store = new Map<string, CacheEntry>();
    private readonly ttlMs = 60_000;

    get(key: string): ChatMessage[] | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() - entry.at > this.ttlMs) {
            this.store.delete(key);
            return null;
        }
        return entry.messages;
    }

    set(key: string, messages: ChatMessage[]): void {
        this.store.set(key, { messages, at: Date.now() });
    }

    invalidate(ref: Ref): void {
        for (const key of this.store.keys()) {
            if (key.startsWith(ref)) this.store.delete(key);
        }
    }

    invalidateAll(): void {
        this.store.clear();
    }
}

// ─── RoundManifest-backed RefStore ────────────────────────────────────────

class RoundRefStore implements RefStore {
    constructor(
        private readonly graph: RoundGraphService,
    ) {}

    async create(name: string, at: RoundId): Promise<Ref> {
        return this.graph.createRef(name, at);
    }

    async move(ref: Ref, to: RoundId): Promise<void> {
        return this.graph.moveRef(ref, to);
    }

    async delete(ref: Ref): Promise<void> {
        return this.graph.deleteRef(ref);
    }

    async list(): Promise<Ref[]> {
        return this.graph.listRefs();
    }
}

// ─── RoundLog ─────────────────────────────────────────────────────────────

/**
 * Native Round DAG ILog implementation.
 *
 * Storage layout (under the .chat file's asset directory):
 *   round-<roundId>.json    — individual Round files (flat, no sub-directory)
 *   manifest.json           — RoundManifest DAG index
 */
export class RoundLog implements ILog {
    private readonly _refs: RoundRefStore;
    private readonly _cache = new FoldCache();
    private readonly graph: RoundGraphService;
    private readonly profileStore: ContextProfileStore;
    private readonly sessionId: string;

    /** Register a callback to receive RoundLogEvent after each mutation. */
    setEventListener(fn: (event: RoundLogEvent) => void): void {
        this.graph.setEventListener(fn);
    }

    constructor(
        engine: ISessionRepository,
        sessionId: string,
    ) {
        this.sessionId = sessionId;
        this.graph = new RoundGraphService(engine, sessionId);
        this.profileStore = new ContextProfileStore(engine, sessionId);
        this._refs = new RoundRefStore(this.graph);
    }



    // ── ILog implementation ───────────────────────────────────────────────

    async append(ref: Ref, round: Round): Promise<RoundId> {
        const roundId = await this.graph.append(ref, round);
        this._cache.invalidate(ref);
        return roundId;
    }

    async appendExpected(ref: Ref, round: Round, expectedHead: RoundId | null): Promise<RoundId> {
        const roundId = await this.graph.append(ref, round, expectedHead);
        this._cache.invalidate(ref);
        return roundId;
    }

    async fold(ref: Ref, _strategy?: AssemblyStrategy): Promise<ChatMessage[]> {
        // Strategy: §3.4 — only 'concat' is implemented (YAGNI for now)
        const manifest = await this.loadManifest();
        const headId = manifest.branches[ref];
        if (!headId) return []; // empty branch — no phantom root
        const profilePointer = manifest.branchMeta[ref]?.contextProfile;
        const cacheKey = `${ref}@${headId}@${profilePointer?.id ?? 'default'}:${profilePointer?.revision ?? 0}`;
        const cached = this._cache.get(cacheKey);
        if (cached) return cached;
        const profile = profilePointer
            ? await this.profileStore.getProfile(profilePointer.id, profilePointer.revision)
            : null;

        const messages = await foldContextHistory(headId, id => this.readRound(id), profile);
        this._cache.set(cacheKey, messages);
        return messages;
    }

    refs(): RefStore {
        return this._refs;
    }

    async merge(refs: Ref[], strategy: AssemblyStrategy): Promise<Ref> {
        const mergeRef = `merge-${ulid().slice(0, 8)}`;
        const branches = await Promise.all(refs.map(r => this.fold(r)));
        const manifest = await this.loadManifest();
        const parentIds = refs
            .map(ref => manifest.branches[ref])
            .filter((id): id is RoundId => !!id);

        let output: ChatMessage[];
        switch (strategy.type) {
            case 'concat': {
                const seen = new Set<string>();
                output = [];
                for (const msg of branches.flat()) {
                    const key = `${msg.role}:${typeof msg.content === 'string' ? msg.content.slice(0, 80) : ''}`;
                    if (!seen.has(key)) { seen.add(key); output.push(msg); }
                }
                break;
            }
            default:
                output = branches.flat();
        }

        const mergeRound: Round = {
            id: ulid(),
            sessionId: this.sessionId,
            historyParentIds: parentIds,
            input: [],
            output,
            executions: [],
            status: 'completed',
            createdAt: Date.now(),
            completedAt: Date.now(),
            origin: 'merge',
            assembly: strategy,
        };
        await this.append(mergeRef, mergeRound);
        return mergeRef;
    }

    async rebase(_ref: Ref, insertAfter: RoundId, rounds: Round[], _opts?: { regenerate?: boolean }): Promise<Ref> {
        const newRef = `rebase-${ulid().slice(0, 8)}`;
        await this._refs.create(newRef, insertAfter);
        for (const round of rounds) {
            await this.append(newRef, round);
        }
        return newRef;
    }

    // ── Round-format-specific mutations (§3.3 in-place mutation whitelist) ──

    /** Remove assistant payload from a Round — used by delete-assistant and resend. */
    async clearAssistantInRound(roundId: RoundId): Promise<void> {
        await this.graph.clearAssistantInRound(roundId);
        this._cache.invalidateAll();
    }

    /** Replace assistant/tool output in an existing Round without changing its identity. */
    async setAssistantInRound(
        roundId: RoundId,
        update: { assistantMessages: ChatMessage[]; result?: RoundResult; agentId?: string },
    ): Promise<void> {
        await this.graph.setAssistantInRound(roundId, update);
        this._cache.invalidateAll();
    }

    async setConversationStatus(
        roundId: RoundId,
        status: NonNullable<Round['status']>,
        error?: string,
        result?: RoundResult,
    ): Promise<void> {
        await this.graph.setConversationStatus(roundId, status, error, result);
        this._cache.invalidateAll();
    }

    async attachExecution(
        roundId: RoundId,
        execution: import('../contracts').ExecutionRef,
    ): Promise<void> {
        await this.graph.attachExecution(roundId, execution);
        this._cache.invalidateAll();
    }

    /** True when a Round contains a meaningful assistant response. */
    static hasEffectiveAssistant(round: PersistedRound): boolean {
        return hasEffectiveAssistant(round);
    }

    /** Create and activate a sibling Round containing only the source user message. */
    async forkUserRound(
        sourceRoundId: RoundId,
        options: { branchName?: Ref; createdFrom: 'regenerate' | 'manual' | 'edit' },
    ): Promise<{ branchName: Ref; sourceRoundId: RoundId; newRoundId: RoundId; commonHeadId?: RoundId }> {
        const result = await this.graph.forkUserRound(sourceRoundId, options);
        this._cache.invalidateAll();
        return result;
    }

    async createBranchForReplacement(
        sourceRoundId: RoundId | null,
        newRootRoundId: RoundId,
        options: { branchName?: Ref; createdFrom: 'regenerate' | 'manual' | 'edit' },
    ): Promise<{ branchName: Ref; commonHeadId?: RoundId }> {
        const result = await this.graph.createBranchForReplacement(sourceRoundId, newRootRoundId, options);
        this._cache.invalidateAll();
        return result;
    }

    /** Enumerate siblings using the persisted Round DAG index. */
    async getSiblingRoundIds(roundId: RoundId): Promise<RoundId[]> {
        return this.graph.getSiblingRoundIds(roundId);
    }

    async getSiblingRounds(roundId: RoundId): Promise<RoundProjection[]> {
        const ids = await this.getSiblingRoundIds(roundId);
        const rounds = await Promise.all(ids.map(id => this.readRound(id)));
        return rounds.filter((round): round is PersistedRound => !!round && !round._deleted)
            .map(round => roundToProjection(round, round.id));
    }

    async renameRef(oldName: Ref, newName: Ref): Promise<void> {
        await this.graph.renameRef(oldName, newName);
        this._cache.invalidateAll();
    }

    /** Mark a Round as stale. */
    async markStale(roundId: RoundId): Promise<void> {
        await this.graph.markStale(roundId);
        this._cache.invalidateAll();
    }

    /** Soft-delete a Round — set _deleted flag so fold() skips it. */
    async deleteRound(roundId: RoundId): Promise<void> {
        await this.graph.deleteRound(roundId);
        this._cache.invalidateAll();
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    async readRound(roundId: RoundId): Promise<PersistedRound | null> {
        return this.graph.readRound(roundId);
    }

    // ── Manifest access (package-internal, used by RoundRefStore) ─────────

    /** Load the RoundManifest from the session manifest. */
    async loadManifest(): Promise<RoundManifest> {
        return this.graph.loadManifest();
    }

    /** Copy-on-write branch context rules used by fold(). */
    async setRoundContextRules(
        ref: Ref,
        roundIds: RoundId[],
        mode: 'include' | 'exclude',
        scope: 'node' | 'subtree' = 'subtree',
    ): Promise<{ profileId: string; revision: number }> {
        const manifest = await this.loadManifest();
        let pointer = manifest.branchMeta[ref]?.contextProfile;
        const expectedRevision = pointer?.revision;
        if (!pointer) {
            const created = await this.profileStore.createProfile();
            pointer = { id: created.id, revision: created.revision };
        }
        const updates = Object.fromEntries(
            [...new Set(roundIds)].map(id => [id, { mode, scope } satisfies ContextRule]),
        );
        const profile = await this.profileStore.updateProfile(pointer.id, pointer.revision, updates);
        await this.graph.setContextProfile(ref, profile.id, profile.revision, expectedRevision);
        this._cache.invalidate(ref);
        return { profileId: profile.id, revision: profile.revision };
    }

    async getRoundContextModes(ref: Ref, roundIds: RoundId[]): Promise<Record<RoundId, 'include' | 'exclude' | 'summary'>> {
        const manifest = await this.loadManifest();
        const pointer = manifest.branchMeta[ref]?.contextProfile;
        const profile = pointer
            ? await this.profileStore.getProfile(pointer.id, pointer.revision)
            : null;
        const result: Record<RoundId, 'include' | 'exclude' | 'summary'> = {};
        for (const id of [...new Set(roundIds)]) {
            const round = await this.readRound(id);
            result[id] = profile?.rules[id]?.mode
                ?? (round?.defaultContextMode === 'exclude' ? 'exclude' : 'include');
        }
        return result;
    }

    /** Persist the RoundManifest back to the session manifest file. */
    async saveManifest(manifest: RoundManifest): Promise<void> {
        return this.graph.saveManifest(manifest);
    }
}

/** Shared assistant validity predicate for operations, persistence and tests. */
export function hasEffectiveAssistant(round: PersistedRound): boolean {
    return round.output.some(message => {
        if (message.role !== 'assistant') return false;
        const content = message.content as unknown;
        return typeof content === 'string'
            ? content.trim().length > 0
            : content != null && String(content).trim().length > 0;
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function detectRoundKind(round: PersistedRound): 'system' | 'chat' | 'merge' {
    if (round.origin === 'merge') return 'merge';
    if (round.input[0]?.role === 'system') return 'system';
    return 'chat';
}

export function roundToProjection(round: PersistedRound, roundId: RoundId): RoundProjection {
    const userMsg = round.input.find(m => m.role === 'user');
    // Use the LAST assistant message (final exchange), not the first.
    const assistantMsgs = round.output.filter(m => m.role === 'assistant');
    const assistantMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : undefined;
    const attachments = (userMsg && 'attachments' in userMsg && Array.isArray(userMsg.attachments))
        ? userMsg.attachments.map(a => ({
            name: a.name ?? a.filename ?? '',
            type: a.type ?? 'file',
            size: a.size,
        }))
        : undefined;
    const kind = detectRoundKind(round);

    return {
        roundId,
        historyParentIds: round.historyParentIds,
        kind,
        userMessage: userMsg ? {
            content: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content),
            files: attachments,
            persistedNodeId: roundId,
        } : undefined,
        assistantMessage: assistantProjection(round, kind, assistantMsg, roundId),
        createdAt: round.createdAt,
        origin: round.origin,
        agentId: round.agentId,
        stale: round.stale,
        defaultContextMode: round.defaultContextMode,
    };
}

/**
 * Project the assistant part of a Round.
 *
 * A chat Round that failed or was cancelled before producing output must still
 * yield an assistant placeholder: otherwise the transcript ends on the user
 * message and the next send is rejected as a consecutive user message, leaving
 * the session permanently unusable.
 */
function assistantProjection(
    round: PersistedRound,
    kind: RoundProjection['kind'],
    assistantMsg: PersistedRound['output'][number] | undefined,
    roundId: RoundId,
): RoundProjection['assistantMessage'] {
    const status = roundStatusToNodeStatus(round.status);
    if (assistantMsg) {
        return {
            content: typeof assistantMsg.content === 'string' ? assistantMsg.content : JSON.stringify(assistantMsg.content),
            thinking: (assistantMsg as { thinking?: string }).thinking,
            status,
            persistedNodeId: roundId,
            flowInteractions: round.result?.flowInteractions, toolCalls: toolCallsFromResult(round.result),
            error: round.error,
        };
    }
    if (kind === 'chat' && round.input.some(m => m.role === 'user')) {
        if (isFailedRoundStatus(round.status)) return { content: '', status, persistedNodeId: roundId, error: round.error,
            // Tools the failed Round had already started; the projection must not silently drop them.
            flowInteractions: round.result?.flowInteractions, toolCalls: toolCallsFromResult(round.result) };
        // A round that already recorded an execution but never reached a terminal status means the
        // host that owned the run is gone. Project it as *running* so the transcript does not end on
        // the user message (which would refuse the next send) and the host can offer to re-run it.
        // Preserve waiting identity so input requests remain visible without reporting a lost run.
        if ((round.status === 'running' || round.status === 'pending' || round.status === 'waiting') && round.executions.length > 0) {
            return { content: '', status, persistedNodeId: roundId, flowInteractions: round.result?.flowInteractions };
        }
    }
    return undefined;
}
