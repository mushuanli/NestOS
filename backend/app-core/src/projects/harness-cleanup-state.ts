import { FSError } from '@itookit/vfs-core';
import type { EffectExecutionContext, EffectSessionState, Kernel } from '@itookit/durable-kernel';
import { harnessExecutionJournalKey } from './harness-execution';
import type { SessionLeaseRecord } from '../kernel/session-lease';

/** Cleanup must neither reenter recovery nor acquire ownership that its Effect no longer holds. */
export async function renewHarnessCleanupLease(sessionId: string, held: Map<string, SessionLeaseRecord>,
    renew: (lease: SessionLeaseRecord) => Promise<SessionLeaseRecord | null>): Promise<void> {
    const current = held.get(sessionId);
    if (!current) throw new FSError('EACCES', 'Harness cleanup no longer owns the Session lease');
    const renewed = await renew(current);
    if (!renewed || held.get(sessionId)?.fencingToken !== current.fencingToken)
        throw new FSError('EACCES', 'Harness cleanup lost the Session lease');
    held.set(sessionId, renewed);
}

/** Cleanup may access only its own receipt journal, even when it has no live Effect state port. */
export function createHarnessCleanupState(kernel: () => Pick<Kernel, 'openSession'>,
    ensureWritable: (sessionId: string) => Promise<void> = async () => {}): (context: EffectExecutionContext) => Promise<EffectSessionState> {
    return async context => {
        const allowed = harnessExecutionJournalKey(context);
        const assertKey = (key: string) => { if (key !== allowed) throw new FSError('EACCES', 'Harness cleanup may only access its own operation journal'); };
        const session = await kernel().openSession(context.sessionId);
        return {
            get: async key => { assertKey(key); await ensureWritable(context.sessionId); return session.getShared(key); },
            set: async (key, value, expectedVersion) => {
                assertKey(key); await ensureWritable(context.sessionId);
                return session.setShared(key, value, expectedVersion === undefined ? undefined : { expectedVersion });
            },
        };
    };
}
