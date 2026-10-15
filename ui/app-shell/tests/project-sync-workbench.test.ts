import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApplicationRuntime, ProjectSyncService } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { SyncError } from '@itookit/vfs-sync';
import { t } from '@itookit/common';
import { initialState, MemoryState, SerialCoordinator } from '../../../tests/helpers/sync';

afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
it('shows stale sync bindings on real project icons without disrupting local navigation or resolving an MCP', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', remoteSourceProvider: {
        setCredential: vi.fn(), dispose: vi.fn(), open: vi.fn()}});
    const project = await runtime.projects.current(); expect(project).toBeDefined();
    const state = initialState(); state.binding.localProjectId = project!.project.id; state.binding.connectionId = 'old-sync-mcp';
    const store = new MemoryState(state);
    const service = new ProjectSyncService({open: async id => {
        if (id !== project!.project.id) throw new SyncError('BINDING_NOT_FOUND');
        return {store, cancel: vi.fn(), preview: vi.fn(), execute: vi.fn(), recover: vi.fn()};
    }}, new SerialCoordinator());
    const resolve = vi.spyOn(runtime.projects.remoteMounts!, 'connection');
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn();
    const workbench = createTestWorkbench({ sidebar, container: main, repository: runtime.sessionRepository, files: runtime.sessionFiles,
        projects: runtime.projects, projectSync: service, kernel: runtime.kernel.kernel, factory, fileFactory: factory, onSelect() {}, hostContext: undefined});
    try {
        await workbench.start(); await workbench.openResource('/');
        await vi.waitFor(() => expect(sidebar.querySelector('.project-sync-icon')).not.toBeNull());
        expect(sidebar.querySelector('.project-sync-icon')?.getAttribute('title')).toContain(t('project.sync.issue.connectionMissing'));
        expect(main.textContent).not.toContain('ENOENT'); expect(resolve).not.toHaveBeenCalled();
    } finally {await workbench.destroy(); await service.dispose(); await runtime.dispose();}
});
