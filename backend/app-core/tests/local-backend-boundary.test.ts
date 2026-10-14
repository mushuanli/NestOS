import { describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import type { SnapshotPort } from '@itookit/app-contracts/settings';
import type { ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { bindLocalApplicationServices, createLocalBackendPort } from '../src/host/local-backend';

describe('local host boundary', () => {
    it('binds UI services without exposing runtime disposal, assembly or conversation ownership', () => {
        const runtime = { dispose: vi.fn(), openConversation: vi.fn(), prepareSession: vi.fn(async () => true), startBackground: vi.fn() } as unknown as ApplicationRuntime;
        const services = bindLocalApplicationServices(runtime);
        expect(services).not.toHaveProperty('dispose'); expect(services).not.toHaveProperty('openConversation');
        expect(services).not.toHaveProperty('runCatalog');
        services.startBackground?.(); expect(runtime.startBackground).toHaveBeenCalledOnce();
    });
    it('runs settings persistence headlessly and delegates snapshots to the selected host', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        const snapshots: SnapshotPort = { estimate: vi.fn(async () => ({ usage: 128, quota: 1024 })), listLocalSnapshots: vi.fn(async () => []), createSnapshot: vi.fn(async () => {}),
            restoreSnapshot: vi.fn(async () => {}), deleteSnapshot: vi.fn(async () => {}), factoryReset: vi.fn(async () => {}) };
        const service = createLocalBackendPort({ snapshots: () => snapshots }).settings(manager, []);
        try {
            await service.init(); await service.saveContact({ id: 'contact', name: 'Name' });
            expect(service.getContacts()).toEqual([{ id: 'contact', name: 'Name' }]);
            await service.writePreference('/ui/theme.json', '{"mode":"dark"}');
            expect(await service.readPreference('/ui/theme.json')).toBe('{"mode":"dark"}');
            await service.createSnapshot(); expect(snapshots.createSnapshot).toHaveBeenCalledOnce();
            expect(await service.estimateStorage()).toEqual({ usage: 128, quota: 1024 });
        } finally { await service.dispose(); await manager.dispose(); }
    });
    it('rejects unsupported maintenance without closing the filesystem', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        const service = createLocalBackendPort().settings(manager, []);
        try {
            await expect(service.factoryReset()).rejects.toMatchObject({ code: 'ECAPABILITY' });
            await service.init(); expect(service.getContacts()).toEqual([]);
        } finally { await service.dispose(); await manager.dispose(); }
    });
});
