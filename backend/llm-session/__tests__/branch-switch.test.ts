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
