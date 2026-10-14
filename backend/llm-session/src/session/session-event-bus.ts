// @file: llm-conversation/session/session-event-bus.ts

import { EventBus } from '@itookit/vfs-core';
import { SessionEvent, SessionEventEnvelope, RegistryEvent } from '../core/types';
import { createSessionHost, type SessionHost } from '../utils/host-ports';

// ── Type maps for the two tracks ─────────────────────────────────────────────

/**
 * Map from SessionEvent.type → payload for the EventBus.
 *
 * Canonical AgentEvents use flat fields (no payload wrapper);
 * MessageProjectionEvent and SessionStructuralEvent use { type, payload }.
 * The bus normalizes both to { type, payload } at the boundary.
 */
type SessionEventMap = {
    [E in SessionEvent as E['type']]: E extends { payload: infer P } ? P : Omit<E, 'type'>;
};

/** Map from RegistryEvent.type → payload, for the global track. */
type RegistryEventMap = {
    [E in RegistryEvent as E['type']]: E['payload'];
};

/**
 * Session event bus — two isolated tracks:
 *   • session track  — per-session events, routed via channel(sessionId)
 *   • global track   — broadcast RegistryEvent
 *
 * Channel lifecycle = session registration lifecycle:
 *   ensureSession → channel open (emits accepted)
 *   removeSession → channel closed (subsequent emits silently dropped)
 */
export class SessionEventBus {
    constructor(readonly host: SessionHost = createSessionHost()) {}
    private readonly sessionBus = new EventBus<SessionEventMap>();
    private readonly globalBus  = new EventBus<RegistryEventMap>();

    // ── Session lifecycle ──────────────────────────────────────────────────

    ensureSession(sessionId: string): void {
        this.sessionBus.channel(sessionId); // idempotent
    }

    removeSession(sessionId: string): void {
        this.sessionBus.closeChannel(sessionId);
        this.host.logger.debug('Session removed from event bus', { sessionId });
    }

    hasSession(sessionId: string): boolean {
        return this.sessionBus.hasChannel(sessionId);
    }

    // ── Session events ─────────────────────────────────────────────────────

    onSession(
        sessionId: string,
        handler: (event: SessionEventEnvelope) => void,
    ): () => void {
        this.ensureSession(sessionId);
        return this.sessionBus.channel(sessionId).onAny((payload, meta) => {
            try {
                // Reconstruct as { type, payload } wrapper at the bus boundary.
                // SessionEventBus normalizes flat AgentEvent fields into payload,
                // so the handler always receives the SessionEventEnvelope shape.
                handler({ type: meta.type, payload } as SessionEventEnvelope);
            } catch (err) {
                this.host.logger.error('Session event listener error', { sessionId, eventType: meta.type, err });
            }
        });
    }

    /**
     * Emit a session event.
     *
     * Normalizes canonical AgentEvent (flat fields) and projection/structural
     * events ({ type, payload } wrapper) to { type, payload } at the bus level.
     */
    emitSession(sessionId: string, event: SessionEvent): void {
        if (!this.sessionBus.hasChannel(sessionId)) {
            this.host.logger.debug('Event dropped (session not registered)', { sessionId, eventType: event.type });
            return;
        }

        let payload: unknown;
        if ('payload' in event) {
            // MessageProjectionEvent / SessionStructuralEvent — already wrapped
            payload = event.payload;
        } else {
            // Canonical AgentEvent — flat fields become payload
            const { type: _, ...rest } = event;
            payload = rest;
        }

        // SAFETY: Discriminated union dispatch — SessionEvent.type narrows to the
        // correct payload type at runtime. TS can't verify generically, same as
        // EventBuffer.commit() (event-buffer.ts:58).
        this.sessionBus.channel(sessionId).emit(
            event.type as keyof SessionEventMap,
            payload as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        );
    }

    /**
     * Clear all local listeners for a session without closing its channel.
     * Background tasks can still emit; UI just stops receiving.
     */
    clearSessionListeners(sessionId: string): void {
        if (!this.sessionBus.hasChannel(sessionId)) return;
        this.sessionBus.channel(sessionId).clearLocal();
    }

    // ── Global events ──────────────────────────────────────────────────────

    onGlobal(handler: (event: RegistryEvent) => void): () => void {
        return this.globalBus.onAny((payload, meta) => {
            try {
                handler({ type: meta.type, payload } as RegistryEvent);
            } catch (err) {
                this.host.logger.error('Global event listener error', { eventType: meta.type, err });
            }
        });
    }

    emitGlobal(event: RegistryEvent): void {
        // SAFETY: Same discriminated union dispatch pattern as emitSession.
        this.globalBus.emit(
            event.type as keyof RegistryEventMap,
            event.payload as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        );
    }

    clearGlobalListeners(): void {
        this.globalBus.clear();
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    clear(): void {
        this.sessionBus.clear();
        this.globalBus.clear();
    }

    // ── Debug ──────────────────────────────────────────────────────────────

    stats(): { sessions: number; globalHandlers: number } {
        const s = this.sessionBus.stats();
        const g = this.globalBus.stats();
        return { sessions: s.channels, globalHandlers: g.handlers };
    }
}
