import { describe, expect, it } from 'vitest';
import type { ISessionRepository } from '../src/persistence/types';
import { ContextProfileStore } from '../src/persistence/context-profile-store';

function memoryEngine(): ISessionRepository {
    const assets = new Map<string, string>();
    return {
        writeDocument: async (_nodeId: string, name: string, content: string | ArrayBuffer) => {
            assets.set(name, typeof content === 'string' ? content : new TextDecoder().decode(content));
            return name;
        },
        readDocument: async (_nodeId: string, name: string) => assets.get(name) ?? null,
    } as unknown as ISessionRepository;
}

describe('ContextProfileStore', () => {
    it('uses expected revision and rejects concurrent copy-on-write conflicts', async () => {
        const store = new ContextProfileStore(memoryEngine(), 'chat');
        const initial = await store.createProfile();
        const results = await Promise.allSettled([
            store.updateProfile(initial.id, initial.revision, { a: { mode: 'exclude' } }),
            store.updateProfile(initial.id, initial.revision, { b: { mode: 'exclude' } }),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    });
});
