import { createContextProfiles, type BranchContextProfile, type ContextRule, type IContextProfiles } from '@itookit/llm-context';
import type { ISessionRepository } from './types';
import { ulid } from './ulid';

/** Legacy document storage adapter. The host Session lease fences cross-process writes. */
export class ContextProfileStore implements IContextProfiles {
    private static readonly tails = new Map<string, Promise<void>>();
    private readonly profiles: IContextProfiles;
    constructor(private readonly engine: ISessionRepository, private readonly sessionId: string) {
        this.profiles = createContextProfiles({ read: (id, revision) => this.read(id, revision),
            create: profile => this.create(profile), id: ulid, now: Date.now });
    }
    createProfile() { return this.profiles.createProfile(); }
    getProfile(id: string, revision: number) { return this.profiles.getProfile(id, revision); }
    updateProfile(id: string, revision: number, rules: Record<string, ContextRule>) {
        return this.profiles.updateProfile(id, revision, rules);
    }
    effectiveMode(id: string, revision: number, roundId: string, fallback?: 'include' | 'exclude') {
        return this.profiles.effectiveMode(id, revision, roundId, fallback);
    }
    private async read(id: string, revision: number): Promise<BranchContextProfile | null> {
        const content = await this.engine.readDocument(this.sessionId, this.name(id, revision));
        if (!content) return null;
        return JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content));
    }
    private async create(profile: BranchContextProfile): Promise<void> {
        const key = this.sessionId;
        const previous = ContextProfileStore.tails.get(key) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(async () => {
            if (await this.read(profile.id, profile.revision)) throw new Error('Context profile revision conflict');
            await this.engine.writeDocument(this.sessionId, this.name(profile.id, profile.revision), JSON.stringify(profile));
        });
        ContextProfileStore.tails.set(key, pending);
        try { await pending; }
        finally { if (ContextProfileStore.tails.get(key) === pending) ContextProfileStore.tails.delete(key); }
    }
    private name(id: string, revision: number): string { return `context-profile-${id}-r${revision}.json`; }
}
