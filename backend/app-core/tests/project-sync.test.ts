import { describe, it, expect } from 'vitest';
import { ProjectSyncService } from '../src/projects/sync/service';
import { MemoryState, SerialCoordinator } from '../../../tests/helpers/sync';
import { bindingToken, type StoredFilePlan, type FilePlan } from '@itookit/vfs-sync';
function setup(cancel: () => Promise<void> = async () => {}) {
    const store = new MemoryState();
    const session = { store, preview: async () => ({ id: 'preview' } as StoredFilePlan), execute: async () => ({ actions: [], conflicts: [], warnings: [] } as FilePlan), recover: async () => {}, cancel };
    const service = new ProjectSyncService({ open: async () => session }, new SerialCoordinator());
    return { store, service };
}
describe('project sync lifecycle', () => {
    it('blocks ordinary synchronization while first-time binding is incomplete', async () => {
        const { store, service } = setup(); store.state.setupPending = true;
        expect((await service.status('local')).setupPending).toBe(true);
        await expect(service.preview('local')).rejects.toThrow('BINDING_INACTIVE');
        await expect(service.execute('local', 'plan')).rejects.toThrow('BINDING_INACTIVE');
    });
    it('detaches even if cloud cancellation cannot be confirmed, retaining recovery data', async () => {
        const { store, service } = setup(async () => { throw new Error('offline'); });
        await expect(service.unbind('local')).rejects.toThrow('offline');
        expect(store.state.binding.state).toBe('detached'); expect(store.state.binding.bindingRevision).toBe('2');
        await expect(service.preview('local')).rejects.toThrow('BINDING_INACTIVE');
    });
    it('rejects a policy change based on an old binding revision', async () => {
        const { store, service } = setup(); const token = bindingToken(store.state.binding);
        await service.configure('local', token, { direction: 'download' });
        await expect(service.configure('local', token, { direction: 'upload' })).rejects.toThrow('BINDING_CHANGED');
        expect(store.state.binding.direction).toBe('download');
    });
    it('cannot access a binding through a different local project', async () => {
        const { service } = setup(); await expect(service.preview('wrong')).rejects.toThrow('BINDING_INACTIVE');
    });
});
it('blocks direction changes while publication or application is pending',async()=>{
    const {store,service}=setup();store.state.activePlanId='in-progress';
    await expect(service.configure('local',bindingToken(store.state.binding),{direction:'upload'})).rejects.toThrow('SYNC_APPLY_PENDING');
    expect(store.state.binding.direction).toBe('both');
});
