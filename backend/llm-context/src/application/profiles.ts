import type { BranchContextProfile, ContextRule } from '../domain/context';

export interface IContextProfiles {
    createProfile(): Promise<BranchContextProfile>;
    getProfile(id: string, revision: number): Promise<BranchContextProfile | null>;
    updateProfile(id: string, revision: number, rules: Record<string, ContextRule>): Promise<BranchContextProfile>;
    effectiveMode(id: string, revision: number, roundId: string, fallback?: 'include' | 'exclude'): Promise<'include' | 'exclude' | 'summary'>;
}
export interface ContextProfilePort {
    read(id: string, revision: number): Promise<BranchContextProfile | null>;
    /** Must reject an existing immutable revision, including concurrent writers. */
    create(profile: BranchContextProfile): Promise<void>;
    id(): string;
    now(): number;
}

export function createContextProfiles(port: ContextProfilePort): IContextProfiles {
    return {
        async createProfile() {
            const profile = { id: port.id(), revision: 1, createdAt: port.now(), rules: {} };
            await port.create(profile);
            return profile;
        },
        getProfile: (id, revision) => port.read(id, revision),
        async updateProfile(id, revision, rules) {
            const previous = await port.read(id, revision);
            if (!previous) throw new Error(`Profile not found: ${id} r${revision}`);
            const profile = { id, revision: revision + 1, createdAt: port.now(), rules: { ...previous.rules, ...rules } };
            await port.create(profile);
            return profile;
        },
        async effectiveMode(id, revision, roundId, fallback) {
            return (await port.read(id, revision))?.rules[roundId]?.mode ?? fallback ?? 'include';
        },
    };
}
