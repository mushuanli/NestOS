import { describe, expect, it, vi } from 'vitest';
import { BranchService } from '../src/session/branch-service';
import type { SessionRegistry } from '../src/session/session-registry';
function setup(currentBranch: string) {
    const manifest = { rootRoundId: null, children: {}, branches: { main: null, experiment: null }, branchMeta: {}, currentBranch, currentHead: null };
    const registry = { ensureBound: () => ({ sessionId: 's', state: {} }), ensureNotGenerating: vi.fn(),
        engine: { getManifest: async () => manifest, updateManifest: vi.fn(async (_id, updates) => Object.assign(manifest, updates)) },
        reloadSessionData: vi.fn(), eventBus: { emitSession: vi.fn() } };
    return { manifest, registry, service: new BranchService(registry as unknown as SessionRegistry) };
}
describe('Session entry branch selection', () => {
    it('opens an empty main branch and updates the continuation context', async () => {
        const f = setup('experiment'); await f.service.switchBranch('main');
        expect(f.manifest.currentBranch).toBe('main'); expect(f.manifest.currentHead).toBeNull();
        expect(f.registry.reloadSessionData).toHaveBeenCalledWith('s', {});
        expect(f.registry.eventBus.emitSession).toHaveBeenCalledWith('s', expect.objectContaining({ type: 'branch:switched', payload: expect.objectContaining({ branchName: 'main' }) }));
    });
    it('allows reopening the active branch while a task is running', async () => {
        const f = setup('main'); f.registry.ensureNotGenerating.mockImplementation(() => { throw new Error('running'); });
        await f.service.switchBranch('main'); expect(f.registry.ensureNotGenerating).not.toHaveBeenCalled();
        await expect(f.service.switchBranch('experiment')).rejects.toThrow('running');
        expect(f.manifest.currentBranch).toBe('main');
        await expect(f.service.switchBranch('missing')).rejects.toThrow('Branch not found');
    });
});

it('rejects deleting the current branch through the backend command boundary', async () => {
    const f = setup('experiment');
    await expect(f.service.deleteBranch('experiment')).rejects.toThrow('Cannot delete the current branch');
    expect(f.registry.engine.updateManifest).not.toHaveBeenCalled();
});

it('requires a branch name to query distinct payloads at a shared logical head', async () => {
    const round = {id: 'shared', historyParentIds: [], input: [{role: 'user', content: 'Q'}],
        output: [{role: 'assistant', content: 'Original'}], status: 'completed', executions: [], createdAt: 1, origin: 'user'};
    const manifest = {rootRoundId: 'shared', children: {}, currentBranch: 'alternative', currentHead: 'shared',
        branches: {main: 'shared', alternative: 'shared'}, branchMeta: {alternative: {roundOverrides: {shared: 'owned'}}}};
    const registry = {ensureBound: () => ({sessionId: 's'}), engine: {getManifest: async () => manifest,
        readDocument: async (_id: string, name: string) => JSON.stringify(name === 'round-owned.json'
            ? {...round, id: 'owned', output: [{role: 'assistant', content: 'Alternative'}]} : round)}};
    const service = new BranchService(registry as unknown as SessionRegistry);
    await expect(service.getBranchMessages('shared')).rejects.toThrow('Branch name required');
    expect((await service.getBranchMessages('shared', 'main')).map(message => message.content)).toEqual(['Q', 'Original']);
    expect((await service.getBranchMessages('shared', 'alternative')).map(message => message.content)).toEqual(['Q', 'Alternative']);
});
