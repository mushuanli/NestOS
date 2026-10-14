import type { Kernel } from '@itookit/durable-kernel';
import type { ISessionRepository } from '@itookit/llm-session';
import type { SessionLeaseStore, SessionOwnerKind } from '../kernel/session-lease';
import { SessionLifecycleService } from '../session/session-lifecycle';

/** Resume previously confirmed deletions before any affected Session can run again. */
export async function resumeSessionDeletions(repository: ISessionRepository, kernel: Kernel,
    leases: SessionLeaseStore, owner: { id: string; kind: SessionOwnerKind }): Promise<Set<string>> {
    const blocked = new Set<string>();
    const lifecycle = new SessionLifecycleService({ repository, kernel });
    for (const intent of await repository.pendingSessionDeletions()) {
        blocked.add(intent.id);
        const lease = await leases.acquire(intent.id, owner);
        if (!lease) continue;
        try { await lifecycle.deleteSession(intent.id); }
        catch (error) { console.warn(`[Session] Pending deletion requires retry: ${intent.id}`, error); }
        finally { await leases.release(lease); }
    }
    return blocked;
}
