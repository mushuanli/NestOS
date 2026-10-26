import { FSError } from '@itookit/vfs-core';
import type { EffectExecutionContext, EffectSessionState, Kernel, SessionHandle } from '@itookit/durable-kernel';
import { harnessExecutionJournalKey } from './harness-execution-journal';
/** Cleanup may access only its own receipt journal, even when it has no live Effect state port. */
export function createHarnessCleanupState(kernel: () => Pick<Kernel, 'openSession'>,
    ensureWritable: (sessionId: string) => Promise<void> = async () => {}): (context: EffectExecutionContext) => Promise<EffectSessionState> {
    return async context => {
        const allowed = harnessExecutionJournalKey(context);
        await ensureWritable(context.sessionId);
        const session = await kernel().openSession(context.sessionId);
        return harnessCleanupRecord(session, context.sessionId, allowed, ensureWritable);
    };
}

/** Internal host capability for one fixed record; never exposed through application RPC. */
export function harnessCleanupRecord(session: Pick<SessionHandle, 'getShared' | 'setShared'>, sessionId: string, allowed: string,
    ensureWritable: (sessionId: string) => Promise<void>): EffectSessionState {
    const assertKey = (key: string) => {if (key !== allowed) throw new FSError('EACCES', 'Harness cleanup may only access its scoped record');};
    return {
        get: async key => {assertKey(key); await ensureWritable(sessionId); return session.getShared(key);},
        set: async (key, value, expectedVersion) => {
            assertKey(key); await ensureWritable(sessionId);
            return session.setShared(key, value, expectedVersion === undefined ? undefined : {expectedVersion});
        },
    };
}
