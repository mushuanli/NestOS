import { type CoordinationGuard, type FileAction, type FileLocal, type Snapshot, type StoredFilePlan } from '@itookit/vfs-sync';
export interface CapturedFiles { scan: Snapshot; objects: Record<string, Uint8Array<ArrayBuffer>> }
export interface LocalApplicationStore {
    scoped(guard: CoordinationGuard): LocalApplicationStore;
    capture(): Promise<CapturedFiles>;
    putObject(bytes: Uint8Array): Promise<string>;
    object(hash: string): Promise<Uint8Array>;
    persistPlan(key: string, plan: unknown): Promise<void>;
    plan<T>(key: string): Promise<T | undefined>;
    applyCaptured(token: string, handle: unknown, actions: FileAction[], id: string): Promise<void>;
}
/** Both hosts share caching and the distinction between published P and later local P2. */
export class CachedFileLocal implements FileLocal {
    constructor(protected readonly store: LocalApplicationStore) {}
    scoped(guard: CoordinationGuard): CachedFileLocal { return new CachedFileLocal(this.store.scoped(guard)); }
    async capture(): ReturnType<FileLocal['capture']> {
        const captured = await this.store.capture();
        for (const bytes of Object.values(captured.objects)) await this.store.putObject(bytes);
        return { scan: captured.scan, handle: { ...captured, objects: {} } };
    }
    cache(bytes: Uint8Array): Promise<string> { return this.store.putObject(bytes); }
    object(hash: string): Promise<Uint8Array> { return this.store.object(hash); }
    save(plan: StoredFilePlan): Promise<void> { return this.store.persistPlan(plan.id, plan); }
    load(id: string): Promise<StoredFilePlan | undefined> { return this.store.plan(id); }
    apply(token: string, handle: unknown, actions: FileAction[], id: string): Promise<void> {
        return this.store.applyCaptured(token, handle, actions, id);
    }
}
