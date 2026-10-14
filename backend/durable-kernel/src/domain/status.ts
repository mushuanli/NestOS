import type { SessionRecord, TaskRecord } from './types';

export function taskStat(task: TaskRecord) {
    const terminal = !!task.exit;
    const blockedBy = task.sessionPaused ? 'session-control' : task.controlHolds?.length ? 'ancestor-control'
        : task.control && task.control.mode !== 'run' ? 'task-control'
        : task.blockedReason ?? (task.status === 'blocked' ? 'dependency' : task.wait?.type);
    const phase = terminal ? 'done' : task.status === 'running' ? 'running' : blockedBy ? 'waiting'
        : task.status === 'created' ? 'created' : task.status === 'ready' ? 'ready' : 'waiting';
    const activeOperations = Object.values(task.effects).filter(e => e.status === 'pending' || e.status === 'leased' || e.status === 'indeterminate' || e.cleanupPending).length;
    return {
        id: task.id, revision: task.version, phase,
        control: { requested: task.status === 'cancelled' ? 'cancel' : task.control?.mode ?? 'run', acknowledged: task.status === 'cancelled' ? activeOperations === 0 : task.control?.acknowledged ?? true },
        blockedBy, exit: task.exit,
        activeOperations,
    } as const;
}
export function taskStats(task: TaskRecord) {
    return { observedRevision: task.version, completedSteps: task.stepNumber ?? 0,
        attempts: task.attemptCount, pendingInputs: task.pendingEvents.length,
        operations: Object.keys(task.effects).length, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
export function sessionStat(session: SessionRecord, resourceBlocked = false) {
    return { id: session.id, phase: session.status === 'suspending' || session.status === 'suspended' ? 'paused'
        : session.status === 'archived' ? 'closed' : session.status,
        acknowledged: session.status !== 'suspending', archived: session.status === 'archived',
        blockedBy: resourceBlocked ? 'resource-claims' : undefined } as const;
}
/** Stat for a Session whose storage is gone: an interrupted removal, or a stale catalog entry. */
export function closedSessionStat(sessionId: string) {
    return { id: sessionId, phase: 'closed', acknowledged: true, archived: false, blockedBy: undefined } as const;
}
export type TaskStat = ReturnType<typeof taskStat>;
export type TaskStats = ReturnType<typeof taskStats>;
export type SessionStat = ReturnType<typeof sessionStat>;
