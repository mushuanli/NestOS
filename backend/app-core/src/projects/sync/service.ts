import { assertSync, scopedStore, bindingToken, nextDecimal, type Binding, type Coordinator, type StateStore, type StoredFilePlan, type FilePlan } from '@itookit/vfs-sync';

export interface ProjectSyncSession {
    store: StateStore;
    preview(): Promise<StoredFilePlan>;
    execute(planId: string): Promise<FilePlan>;
    recover(): Promise<void>;
    resolve?(planId: string, decisions: Record<string, 'local' | 'remote'>): Promise<StoredFilePlan>;
    mergeText?(planId: string, paths: string[]): Promise<StoredFilePlan>;
    compare?(planId: string, path: string): Promise<ProjectSyncComparison>;
    reconcileExpired?(): Promise<StoredFilePlan>;
    cancel(): Promise<void>;
}
export interface ProjectSyncContent {
    kind: 'missing' | 'file' | 'directory'; hash?: string | null; size?: number;
    content?: { text?: string; reason?: 'binary' | 'too-large' | 'unavailable' };
}
export interface ProjectSyncComparison { path: string; baseline: ProjectSyncContent; local: ProjectSyncContent; remote: ProjectSyncContent }
export interface ProjectSyncProvider {
    open(localProjectId: string): Promise<ProjectSyncSession>;
    dispose?(): Promise<void>;
}
/** Project lifecycle policy; transport and host storage are injected. */
export class ProjectSyncService {
    readonly bindingToken = bindingToken;
    private closed = false;
    private readonly running = new Set<Promise<unknown>>();
    constructor(private readonly provider: ProjectSyncProvider, private readonly coordinator: Coordinator) {}
    preview(projectId: string): Promise<StoredFilePlan> { return this.run(async () => (await this.active(projectId)).preview()); }
    execute(projectId: string, planId: string): Promise<FilePlan> { return this.run(async () => (await this.active(projectId)).execute(planId)); }
    compare(projectId: string, planId: string, path: string): Promise<ProjectSyncComparison> {
        return this.run(async () => {
            const session = await this.active(projectId); assertSync(session.compare, 'SYNC_COMPARISON_UNAVAILABLE');
            return session.compare(planId, path);
        });
    }
    resolve(projectId: string, planId: string, decisions: Record<string, 'local' | 'remote'>): Promise<StoredFilePlan> {
        return this.run(async () => {
            const session = await this.active(projectId); assertSync(session.resolve, 'SYNC_RESOLUTION_UNAVAILABLE');
            return session.resolve(planId, decisions);
        });
    }
    mergeText(projectId: string, planId: string, paths: string[]): Promise<StoredFilePlan> {
        return this.run(async () => {
            const session = await this.active(projectId); assertSync(session.mergeText, 'SYNC_MERGE_UNAVAILABLE');
            return session.mergeText(planId, paths);
        });
    }
    reconcileExpired(projectId: string): Promise<StoredFilePlan> {
        return this.run(async () => {
            const session = await this.active(projectId); assertSync(session.reconcileExpired, 'SYNC_RECONCILIATION_UNAVAILABLE');
            return session.reconcileExpired();
        });
    }
    recover(projectId: string): Promise<void> {
        // Detached operations may query cloud outcomes, but never apply to a new source.
        return this.run(async () => (await this.session(projectId)).recover());
    }
    async status(projectId: string) { return (await this.session(projectId)).store.read(); }
    unbind(projectId: string): Promise<void> { return this.run(() => this.detach(projectId)); }
    private async detach(projectId: string): Promise<void> {
        const session = await this.session(projectId), state = await session.store.read();
        await this.coordinator.exclusive(state.binding.bindingId, async guard => {
            await scopedStore(session.store, guard).update(s => ({ ...s, binding: { ...s.binding,
                state: 'detaching', bindingRevision: nextDecimal(s.binding.bindingRevision) } }));
        });
        try { await session.cancel(); }
        finally {
            await this.coordinator.exclusive(state.binding.bindingId, async guard => {
                await scopedStore(session.store, guard).update(s => {
                    assertSync(s.binding.state === 'detaching', 'BINDING_CHANGED');
                    return { ...s, binding: { ...s.binding, state: 'detached' } };
                });
            });
        }
    }
    configure(projectId: string, expectedToken: string, change: Pick<Binding, 'direction'>): Promise<void> {
        return this.run(() => this.configureUnlocked(projectId, expectedToken, change));
    }
    private async configureUnlocked(projectId: string, expectedToken: string, change: Pick<Binding, 'direction'>): Promise<void> {
        const session = await this.active(projectId), state = await session.store.read();
        await this.coordinator.exclusive(state.binding.bindingId, async guard => {
            await scopedStore(session.store, guard).update(s => {
                assertSync(bindingToken(s.binding) === expectedToken, 'BINDING_CHANGED');
                assertSync(!s.pending && !s.activePlanId, 'SYNC_APPLY_PENDING');
                assertSync(['both', 'upload', 'download'].includes(change.direction), 'INVALID_SYNC_DIRECTION');
                return { ...s, binding: { ...s.binding, ...change, policyRevision: nextDecimal(s.binding.policyRevision) } };
            });
        });
    }
    async dispose(): Promise<void> {
        this.closed = true;
        await Promise.allSettled([...this.running]); await this.provider.dispose?.();
    }
    private async run<T>(action: () => Promise<T>): Promise<T> {
        assertSync(!this.closed, 'SYNC_STOPPED');
        const work = action(); this.running.add(work);
        try { return await work; } finally { this.running.delete(work); }
    }
    private async session(projectId: string): Promise<ProjectSyncSession> {
        assertSync(!this.closed, 'SYNC_STOPPED');
        const session = await this.provider.open(projectId);
        assertSync((await session.store.read()).binding.localProjectId === projectId, 'BINDING_INACTIVE'); return session;
    }
    private async active(projectId: string): Promise<ProjectSyncSession> {
        const session = await this.session(projectId);
        const state = await session.store.read();
        assertSync(state.binding.localProjectId === projectId && state.binding.state === 'active' && !state.setupPending, 'BINDING_INACTIVE');
        return session;
    }
}
