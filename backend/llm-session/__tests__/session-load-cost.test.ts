import { expect, it, vi } from 'vitest';
import { SessionRegistry } from '../src/session/session-registry';
import { BranchService } from '../src/session/branch-service';
import type { ISessionRepository } from '../src/persistence/types';

function fixture(count: number) {
    const records = new Map(Array.from({ length: count }, (_, index) => {
        const id = `r${index}`;
        return [`round-${id}.json`, { id, sessionId: 's', kind: 'chat', status: 'completed',
            historyParentIds: index ? [`r${index - 1}`] : [], createdAt: index,
            input: [{ role: 'user', content: `question ${index}` }], output: [{ role: 'assistant', content: `answer ${index}` }] }];
    }));
    const manifest = { children: {}, rootRoundId: count ? 'r0' : null, currentHead: count ? `r${count - 1}` : null,
        currentBranch: 'main', branches: { main: count ? `r${count - 1}` : null, empty: null }, branchMeta: {} };
    const engine = { getManifest: vi.fn(async () => structuredClone(manifest)),
        updateManifest: vi.fn(async (_id, updates) => Object.assign(manifest, updates)),
        readDocument: vi.fn(async (_id, name: string) => JSON.stringify(records.get(name))) };
    const restore = vi.fn(async round => round);
    const registry = new SessionRegistry(engine as unknown as ISessionRepository, restore);
    return { engine, registry, records, manifest, restore, branches: new BranchService(registry) };
}

it.each([0, 100])('loads %i rounds once each and preserves chronological messages', async count => {
    const f = fixture(count);
    const snapshot = await f.registry.bindSession('s');
    expect(f.engine.getManifest).toHaveBeenCalledTimes(1);
    expect(f.engine.readDocument).toHaveBeenCalledTimes(count);
    expect(f.restore).toHaveBeenCalledTimes(count);
    expect(snapshot.sessions.filter(item => item.role === 'user').map(item => item.content))
        .toEqual(Array.from({ length: count }, (_, index) => `question ${index}`));
});

it('reuses the traversed rounds on branch reload and removes the old projection on an empty branch', async () => {
    const f = fixture(50); await f.registry.bindSession('s');
    await f.branches.switchBranch('empty'); expect(f.registry.getSessions()).toEqual([]);
    f.engine.getManifest.mockClear(); f.engine.readDocument.mockClear();
    await f.branches.switchBranch('main');
    expect(f.engine.getManifest).toHaveBeenCalledTimes(2);
    expect(f.engine.readDocument).toHaveBeenCalledTimes(50);
    expect(f.registry.getSessions()).toHaveLength(100);
});

it('bounds cycles and tolerates a missing ancestor without duplicating messages', async () => {
    const f = fixture(3);
    f.records.get('round-r0.json')!.historyParentIds = ['r2'];
    expect((await f.registry.bindSession('s')).sessions).toHaveLength(6);
    expect(f.engine.readDocument).toHaveBeenCalledTimes(3);
    const missing = fixture(3); missing.records.delete('round-r1.json');
    expect((await missing.registry.bindSession('s')).sessions).toHaveLength(2);
    expect(missing.engine.readDocument).toHaveBeenCalledTimes(2);
});
