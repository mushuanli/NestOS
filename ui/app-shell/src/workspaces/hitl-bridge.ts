import type { SessionManagementPort } from '@itookit/llm-session/contracts';

// ── HITL → vfs-ui bridge ───────────────────────────────────────────────────────
//
// When a background session's agent calls human_input, the SessionManagementPort emits
// session_hitl_active / session_hitl_resolved RegistryEvents. This bridge
// translates those into VFSStore state so the session list renders an orange
// pulsing indicator on the waiting session's .chat file entry.

export function setupHitlVfsBridge(sessionManager: Omit<SessionManagementPort, 'getSessionRuntime'>, setWaitingInput: (id: string, waiting: boolean) => void): () => void {
    // NOTE: This bridge is "eventual" — it only responds to events that fire
    // AFTER the workspace is loaded. Sessions that started waiting before the
    // workspace loaded won't be highlighted until the NEXT input request.
    // In practice this is not an issue because chat workspaces are loaded at
    // app startup, before any background session can trigger human_input.
    return sessionManager.onGlobalEvent((event) => {
        if (event.type === 'session_hitl_active') {
            setWaitingInput(event.payload.sessionId, true);
        } else if (event.type === 'session_hitl_resolved') {
            setWaitingInput(event.payload.sessionId, false);
        } else if (event.type === 'session_status_changed') {
            // Defensive cleanup: if the session is no longer running (aborted /
            // completed / failed), clear any lingering waiting-input indicator.
            // This also clears stale waiting indicators when a Process is cancelled.
            const stopped = event.payload.status !== 'running' && event.payload.status !== 'queued';
            if (stopped) {
            setWaitingInput(event.payload.sessionId, false);
            }
        }
    });
}
