import type {TaskCallAuthority} from '@itookit/durable-kernel';
import {createModuleLogger} from '@itookit/common';

interface Ports {
    assertOwned(sessionId: string): Promise<void>;
    isDeleting(sessionId: string): Promise<boolean>;
    isMoving(sessionId: string): Promise<boolean>;
}
const log = createModuleLogger('session-execution');

/** Calls use already-prepared Sessions; neither execution nor cleanup implicitly acquires ownership. */
export function createSessionTaskCallAuthority(ports: Ports): TaskCallAuthority {
    return async (plan, owner, phase) => {
        const started = Date.now(); let side = 'source', stage = 'ownership', result = 'failure', code: string | undefined;
        try {
            for (const sessionId of new Set([owner.sessionId, plan.targetSessionId])) {
                side = sessionId === owner.sessionId ? 'source' : 'target'; stage = 'ownership';
                await ports.assertOwned(sessionId);
                if (phase === 'execute') {stage = 'availability'; await assertStartable(ports, sessionId);}
            }
            result = 'success';
        } catch (error) {
            const value = (error as {code?: unknown})?.code;
            code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'TASK_CALL_OWNERSHIP_FAILED';
            throw error;
        } finally {
            try {log.info('session.task-call.authorize', {operation: 'session.task-call.authorize', operationId: owner.effectId,
                sessionId: owner.sessionId, taskId: owner.taskId, targetSessionId: plan.targetSessionId,
                phase, stage, side, result, code, durationMs: Date.now() - started});}
            catch { /* Diagnostics cannot grant ownership or replace the original result. */ }
        }
    };
}

async function assertStartable(ports: Ports, sessionId: string): Promise<void> {
    if (await ports.isDeleting(sessionId))
        throw Object.assign(new Error('Task call Session is being deleted'), {code: 'TASK_CALL_SESSION_DELETING'});
    if (await ports.isMoving(sessionId))
        throw Object.assign(new Error('Task call Session is being moved'), {code: 'TASK_CALL_SESSION_MOVING'});
}
