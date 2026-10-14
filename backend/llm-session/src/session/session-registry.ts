import type { PersistedRound } from '../persistence/round-types';
// @file: llm-conversation/session/session-registry.ts

import {
    SessionGroup,
    SessionStatus,
    SessionRuntime,
    SessionSnapshot,
    SessionEventEnvelope,
    RegistryEvent,
} from '../core/types';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import { ISessionRepository, type SessionLoadState } from '../persistence/types';
import { SessionState } from './session-state';
import { SessionEventBus } from './session-event-bus';
import { RoundLog, roundToProjection } from '../persistence/round-log';
import { collectHistoryChain, type SessionHistoryChain } from '../persistence/history-chain';
import { createSessionHost, type SessionHost } from '../utils/host-ports';

/**
 * Context returned by ensureBound() — shared across RoundOperations and BranchService.
 */
export interface BoundContext {
    sessionId: string;
    state: SessionState;
    runtime: SessionRuntime;
}

/**
 * SessionRegistry — session lifecycle, binding, state queries, and event routing.
 *
 * Owns the sessions Map, states Map, and binding state. RoundOperations and
 * BranchService depend on this component for ensureBound(), reloadSessionData(),
 * and event emission.
 */
export class SessionRegistry {
    // === 全局会话存储 ===
    private sessions = new Map<string, SessionRuntime>();
    private states = new Map<string, SessionState>();
    private _activeSessionId: string | null = null;

    // === 当前视图绑定 ===
    private _boundSessionId: string | null = null;
    /** Projection loaded with the head chain, reused by the editor while the binding stands. */
    private readonly views = new Map<string, SessionLoadState>();
    private bindingVersion = 0;
    private eventUnsubscribe: (() => void) | null = null;

    // === 内部组件 ===
    private _eventBus: SessionEventBus;
    private _engine: ISessionRepository;

    constructor(engine: ISessionRepository, private readonly restoreRound: (round: PersistedRound) => Promise<PersistedRound> = async round => round, readonly host: SessionHost = createSessionHost()) {
        this._engine = engine;
        this._eventBus = new SessionEventBus(host);
    }

    // === 访问器（供 RoundOperations / BranchService 使用）===

    get eventBus(): SessionEventBus { return this._eventBus; }
    get engine(): ISessionRepository { return this._engine; }
    get boundSessionId(): string | null { return this._boundSessionId; }
    get activeSessionId(): string | null { return this._activeSessionId; }

    // ── 会话绑定 ───────────────────────────────────────────────────────

    async bindSession(sessionId: string): Promise<SessionSnapshot> {
        const currentVersion = ++this.bindingVersion;
        this.unbindSession();
        this.bindingVersion = currentVersion;
        try {
            await this.ensureRegistered(sessionId);
            if (this.bindingVersion !== currentVersion) {
                throw new ConversationError(ConversationErrorCode.ABORTED, 'Bind cancelled');
            }
            this._boundSessionId = sessionId;
            this._activeSessionId = sessionId;
            const runtime = this.sessions.get(sessionId);
            if (runtime && runtime.unreadCount > 0) {
                runtime.unreadCount = 0;
                this._eventBus.emitGlobal({
                    type: 'session_unread_updated',
                    payload: { sessionId, count: 0 },
                });
            }
            return this.getSnapshot();
        } catch (e) {
            this.host.logger.error('Failed to bind session', { sessionId, error: e });
            throw ConversationError.from(e);
        }
    }

    unbindSession(): void {
        this.bindingVersion++;

        if (this.eventUnsubscribe) {
            this.eventUnsubscribe();
            this.eventUnsubscribe = null;
        }

        if (this._boundSessionId) {
            const runtime = this.sessions.get(this._boundSessionId);
            if (runtime && (runtime.status === 'running' || runtime.status === 'queued')) {
                this._eventBus.clearSessionListeners(this._boundSessionId);
            }
        }

        this._boundSessionId = null;
    }

    /** Update the bound sessionId after the backing VFS file is renamed. */


    // ── 状态查询

    getSnapshot(): SessionSnapshot {
        if (!this._boundSessionId) {
            return { sessionId: '', sessions: [], status: 'idle', isRunning: false };
        }
        const state = this.states.get(this._boundSessionId);
        const runtime = this.sessions.get(this._boundSessionId);
        const status = runtime?.status || 'idle';
        const sessions = state?.getSessions() || [];

        // Detect interrupted execution from VFS meta.status
        let interruptedAssistantId: string | undefined;
        for (let i = sessions.length - 1; i >= 0; i--) {
            const s = sessions[i];
            if (s.role === 'assistant' && s.executionRoot?.status === 'running') {
                interruptedAssistantId = s.id;
                break;
            }
        }

        return {
            sessionId: this._boundSessionId,
            sessions,
            status,
            isRunning: status === 'running' || status === 'queued',
            interruptedAssistantId,
        };
    }

    getSessions(): SessionGroup[] {
        if (!this._boundSessionId) return [];
        return this.states.get(this._boundSessionId)?.getSessions() || [];
    }

    getCurrentSessionId(): string | null { return this._boundSessionId; }

    /**
     * Projection read together with the head chain during the current bind, when the host reads
     * both in one snapshot. It is dropped again when a later bind does not re-read the chain, so
     * callers must treat an absent view as "read the store".
     */
    getLoadedView(sessionId: string): SessionLoadState | undefined { return this.views.get(sessionId); }

    getStatus(): SessionStatus | 'unbound' {
        if (!this._boundSessionId) return 'unbound';
        return this.sessions.get(this._boundSessionId)?.status || 'idle';
    }

    isGenerating(): boolean {
        if (!this._boundSessionId) return false;
        const runtime = this.sessions.get(this._boundSessionId);
        return runtime?.status === 'running' || runtime?.status === 'queued';
    }

    getAllSessions(): SessionRuntime[] {
        return Array.from(this.sessions.values());
    }

    getSessionRuntime(sessionId: string): SessionRuntime | undefined {
        return this.sessions.get(sessionId);
    }

    getSessionState(sessionId: string): SessionState | undefined {
        return this.states.get(sessionId);
    }

    restoreRuntimeMetadata(sessionId: string, metadata: { unreadCount?: number }): void {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) return;
        if (Number.isSafeInteger(metadata.unreadCount) && metadata.unreadCount! >= 0) {
            runtime.unreadCount = metadata.unreadCount!;
        }
    }

    // ================================================================
    // 操作可行性检查
    // ================================================================

    ensureNotGenerating(action: string): void {
        if (this.isGenerating()) {
            throw new ConversationError(
                ConversationErrorCode.SESSION_BUSY,
                `Cannot ${action} while generating`
            );
        }
    }

    canRegenerate(messageId: string): { allowed: boolean; reason?: string } {
        if (this.isGenerating()) return { allowed: false, reason: 'Generating' };
        if (!this._boundSessionId) return { allowed: false, reason: 'No session bound' };

        const state = this.states.get(this._boundSessionId);
        if (!state) return { allowed: false, reason: 'Session not found' };

        const session = state.findSessionById(messageId);
        if (!session) return { allowed: false, reason: 'Message not found' };

        if (session.role === 'user') {
            return { allowed: true };
        }

        if (session.role === 'assistant') {
            const userRound = state.findUserRoundForAssistant(messageId);
            if (!userRound?.userMessage) {
                const reason = state.describeRegenerateFailure(messageId);
                this.host.logger.warn('Regenerate rejected', { messageId, reason });
                return { allowed: false, reason };
            }
            return { allowed: true };
        }

        return { allowed: false, reason: 'Invalid message role' };
    }

    canDeleteMessage(_messageId: string): { allowed: boolean; reason?: string } {
        return { allowed: !this.isGenerating(), reason: this.isGenerating() ? 'Generating' : undefined };
    }

    canEdit(messageId: string): { allowed: boolean; reason?: string } {
        if (this.isGenerating()) return { allowed: false, reason: 'Generating' };

        const state = this.states.get(this._boundSessionId || '');
        if (!state) return { allowed: false, reason: 'No session' };

        const session = state.findSessionById(messageId);
        if (!session) return { allowed: false, reason: 'Message not found' };
        if (session.role !== 'user') return { allowed: false, reason: 'Only user messages can be edited' };

        return { allowed: true };
    }

    // ================================================================
    // 事件
    // ================================================================

    onEvent(handler: (event: SessionEventEnvelope) => void): () => void {
        if (!this._boundSessionId) return () => {};
        if (this.eventUnsubscribe) this.eventUnsubscribe();
        this.eventUnsubscribe = this._eventBus.onSession(this._boundSessionId, handler);
        return this.eventUnsubscribe;
    }

    onGlobalEvent(handler: (event: RegistryEvent) => void): () => void {
        return this._eventBus.onGlobal(handler);
    }

    // ================================================================
    // 守卫：ensureBound — RoundOperations / BranchService 的入口守卫
    // ================================================================

    ensureBound(): BoundContext {
        if (!this._boundSessionId) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID, 'No session bound');
        }

        const state = this.states.get(this._boundSessionId);
        const runtime = this.sessions.get(this._boundSessionId);

        if (!state || !runtime) {
            throw new ConversationError(ConversationErrorCode.SESSION_NOT_FOUND, 'Session state not found');
        }

        return {
            sessionId: this._boundSessionId,
            state,
            runtime,
        };
    }

    // ================================================================
    // 会话加载
    // ================================================================

    async reloadSessionData(
        sessionId: string,
        state: SessionState
    ): Promise<void> {
        await this.diffAndApply(sessionId, state);
    }

    // ================================================================
    // 内部：会话注册
    // ================================================================

    private async ensureRegistered(sessionId: string): Promise<void> {
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId)!;
            const state = this.states.get(sessionId);
            existing.lastActiveTime = Date.now();
            this._eventBus.ensureSession(sessionId);
            // A registered Session is not re-read here, so any projection from an earlier load may
            // be stale: drop it and let the caller read the store (or use its own invalidated cache).
            this.views.delete(sessionId);
            if (state && (existing.status === 'completed' || existing.status === 'failed')) {
                await this.reloadSessionData(sessionId, state);
            }
            return;
        }

        const runtime: SessionRuntime = { sessionId, status: 'idle', lastActiveTime: Date.now(), unreadCount: 0 };
        const state = new SessionState(sessionId);
        await this.populateState(state, sessionId);

        this.sessions.set(sessionId, runtime);
        this.states.set(sessionId, state);
        this._eventBus.ensureSession(sessionId);
        this._eventBus.emitGlobal({ type: 'session_registered', payload: { sessionId } });
    }

    unregisterSession(sessionId: string, abortFn: (id: string) => void): void {
        const runtime = this.sessions.get(sessionId);
        if (runtime && (runtime.status === 'running' || runtime.status === 'queued')) abortFn(sessionId);
        this.sessions.delete(sessionId);
        this.states.delete(sessionId);
        this.views.delete(sessionId);
        this._eventBus.removeSession(sessionId);
        if (this._activeSessionId === sessionId) this._activeSessionId = null;
        this._eventBus.emitGlobal({ type: 'session_unregistered', payload: { sessionId } });
    }

    // ================================================================
    // Internal session lifecycle callbacks.
    // ================================================================

    updateStatus(sessionId: string, status: SessionStatus): void {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) return;
        const prevStatus = runtime.status;
        runtime.status = status;
        runtime.lastActiveTime = Date.now();
        if (status !== 'failed') runtime.error = undefined;
        this._eventBus.emitGlobal({ type: 'session_status_changed', payload: { sessionId, status, prevStatus } });
    }

    incrementUnread(sessionId: string): void {
        if (sessionId === this._boundSessionId) return;
        const runtime = this.sessions.get(sessionId);
        if (runtime) {
            runtime.unreadCount++;
            this._eventBus.emitGlobal({ type: 'session_unread_updated', payload: { sessionId, count: runtime.unreadCount } });
        }
    }

    // ── 清理

    clearAll(abortAllFn: () => void): void {
        abortAllFn();
        this.sessions.clear();
        this.states.clear();
        this._eventBus.clear();
        this._activeSessionId = null;
    }

    cleanupIdleSessions(maxIdleTime: number, abortFn: (id: string) => void): number {
        const now = Date.now();
        let cleaned = 0;
        for (const [sessionId, runtime] of this.sessions) {
            if (sessionId === this._activeSessionId || sessionId === this._boundSessionId) continue;
            if (runtime.status === 'running' || runtime.status === 'queued') continue;
            if (runtime.unreadCount > 0) continue;
            if (now - runtime.lastActiveTime > maxIdleTime) {
                this.unregisterSession(sessionId, abortFn);
                cleaned++;
            }
        }
        if (cleaned > 0) this.host.logger.info('Idle sessions cleaned', { count: cleaned });
        return cleaned;
    }

    // ================================================================
    // 内部：状态填充
    // ================================================================

    private async populateState(
        state: SessionState,
        sessionId: string
    ): Promise<void> {
        await this.populateFromRoundLog(state, sessionId);
    }

    private async collectHeadChain(sessionId: string): Promise<SessionHistoryChain> {
        // One snapshot for the projection and the chain when the host can read both together;
        // the editor reuses this projection instead of reading the Session record again.
        if (this._engine.loadView) {
            const view = await this._engine.loadView(sessionId);
            this.views.set(sessionId, { manifest: view.manifest, settings: view.settings });
            return view.chain;
        }
        if (this._engine.readHistoryChain) return this._engine.readHistoryChain(sessionId);
        const log = new RoundLog(this._engine, sessionId);
        return collectHistoryChain(await log.loadManifest(), id => log.readRound(id));
    }

    private async populateFromRoundLog(
        state: SessionState,
        sessionId: string,
    ): Promise<void> {
        const { rounds } = await this.collectHeadChain(sessionId);
        for (const t of rounds) {
            if (!t || t._deleted) continue;
            state.loadFromProjection(roundToProjection(await this.restoreRound(t), t.id));
        }
    }

    private async diffAndApply(
        sessionId: string,
        state: SessionState,
    ): Promise<void> {
        const { chain, rounds, branch } = await this.collectHeadChain(sessionId);
        if (chain.length === 0) {
            // No head chain (e.g. after a regenerate whose new round is not yet
            // persisted, so currentHead points at a not-yet-existing round).
            // The previous branch's projection must not linger — clear it so the
            // UI drops the stale nodes; the new round arrives via execution.
            const stale = state.getRounds().map(t => t.roundId);
            for (const roundId of stale) {
                const events = state.apply({ type: 'round:deleted', roundId });
                for (const e of events) {
                    this._eventBus.emitSession(sessionId, e);
                }
            }
            const removedTransient = state.retainTransientForRounds(new Set());
            if (removedTransient.length > 0) {
                this._eventBus.emitSession(sessionId, {
                    type: 'messages:deleted',
                    payload: { deletedIds: removedTransient },
                });
            }
            return;
        }

        const headSet = new Set(chain);

        const toRemove = state.getRounds().filter(t => !headSet.has(t.roundId));
        for (const t of toRemove) {
            const events = state.apply({ type: 'round:deleted', roundId: t.roundId });
            for (const e of events) {
                this._eventBus.emitSession(sessionId, e);
            }
        }

        // Transient groups (execution-time bubbles) not in the new head chain —
        // e.g. an assistant created on the previous branch before a switch —
        // must be dropped or the UI would show stale nodes from the old branch.
        const removedTransient = state.retainTransientForRounds(headSet);
        if (removedTransient.length > 0) {
            this._eventBus.emitSession(sessionId, {
                type: 'messages:deleted',
                payload: { deletedIds: removedTransient },
            });
        }

        for (const t of rounds) {
            if (!t || t._deleted) continue;
            if (state.hasRound(t.id)) continue;

            const projection = roundToProjection(await this.restoreRound(t), t.id);
            const events = state.apply({
                type: 'round:appended',
                ref: branch,
                roundId: t.id,
                projection,
            });
            for (const e of events) {
                this._eventBus.emitSession(sessionId, e);
            }
        }
    }
}
