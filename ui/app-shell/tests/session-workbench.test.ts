import { createLocalBackendPort } from '@itookit/app-core/host';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FSError } from '@itookit/vfs-core';
import { RemoteConnectionUnavailableError } from '@itookit/app-core';
import { t } from '@itookit/common';
import { createVFSUI } from '@itookit/vfs-ui';
vi.mock('@itookit/vfs-ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@itookit/vfs-ui')>()),
    filterGitignoredFiles: async (_fs: unknown, _path: string, nodes: unknown[]) => nodes,
    createVFSUI: vi.fn(() => ({ on: () => () => {}, start: async () => {}, getActiveSession: () => undefined, refresh: async () => {}, selectPath: async () => {}, destroy: () => {} })) }));
import { SessionWorkbench } from '../src/projects/SessionWorkbench';
const element = () => document.createElement('div');
function setup() {
    const release = vi.fn(async () => {}), dispose = vi.fn(async () => {});
    const manifest = { currentBranch: 'main' };
    const listeners: Array<() => void> = [];
    const repository = { createSession: vi.fn(async () => 'new-session'), getManifest: vi.fn(async (id: string) => ({ id, title: 'Session', ...manifest })), list: vi.fn(async () => []),
        openAttachments: vi.fn(async () => ({ dispose })), subscribe: (listener: () => void) => { listeners.push(listener); return () => {}; } };
    const files = { subscribe: () => () => {}, inspect: vi.fn(async () => ({ revision: 1 })), acquireFiles: vi.fn(async () => ({ context: { fs: { capabilities: {} }, sessionId: 's' }, release })) };
    const rerunSession = vi.fn(async () => {});
    const destroy = vi.fn(async () => {}), factory = vi.fn(async (...args: any[]) => { manifest.currentBranch = args[1].target.branch ?? 'main'; return { destroy, commands: { rerunSession } }; });
    const onSelect = vi.fn();
    const sidebar = element();
    const kernel = { onChanged: () => () => {}, cancel: vi.fn(async () => {}), task: vi.fn(async () => ({ effects: {} })),
        closeSession: vi.fn(async () => {}), sessionStat: vi.fn(async () => ({ phase: 'closed' })) };
    const workbench = new SessionWorkbench({ backend: createLocalBackendPort(),  sidebar: sidebar as any, container: element() as any, repository: repository as any, files: files as any, factory: factory as any, onSelect: onSelect, hostContext: undefined, kernel: kernel as any, fileFactory: factory as any });
    return { rerunSession, kernel, sidebar, workbench, repository, files, factory, release, dispose, destroy, onSelect, manifest, changed: () => listeners.forEach(listener => listener()) };
}
afterEach(() => vi.unstubAllGlobals());
describe('Session workbench lifecycle', () => {
    it('retains an unavailable MCP binding when restoring a route instead of replacing it as stale', async () => {
        const f = setup(); await f.workbench.start();
        const error = new RemoteConnectionUnavailableError({connectionId: 'missing', connectionName: 'Office',
            reason: 'mcp-not-found', revision: 1, configured: []}, ['project']);
        const open = vi.spyOn(f.workbench, 'openResource').mockRejectedValue(error);
        f.onSelect.mockClear();
        try { await expect(f.workbench.restoreResource('/remote')).resolves.toBeUndefined(); expect(f.onSelect).not.toHaveBeenCalled(); }
        finally {open.mockRestore(); await f.workbench.destroy();}
    });
    it('recovers invalid saved routes but continues to surface storage failures', async () => {
        const f = setup(); await f.workbench.start();
        await f.workbench.restoreResource('/旧项目.prj');
        expect(f.onSelect).toHaveBeenLastCalledWith('', 'replace');
        await f.workbench.openResource('existing');
        f.repository.getManifest.mockRejectedValueOnce(new FSError('ENOENT', 'Deleted'));
        await f.workbench.restoreResource('deleted');
        expect(f.workbench.getActiveResourceId()).toBe('existing?branch=main');
        expect(f.onSelect).toHaveBeenLastCalledWith('existing?branch=main', 'replace');
        f.repository.getManifest.mockRejectedValueOnce(new FSError('EIO', 'Storage failed'));
        await expect(f.workbench.restoreResource('broken')).rejects.toThrow('Storage failed');
        await f.workbench.destroy();
    });
    it('uses vfs-ui for the Session sidebar with directory activation', async () => {
        const f = setup(); await f.workbench.start();
        expect(createVFSUI).toHaveBeenCalledWith(expect.objectContaining({ activateDirectories: true, readOnly: false, exportDirectories: true, fileCreation: expect.objectContaining({ label: '会话' }) }), expect.anything());
        const options = (createVFSUI as any).mock.calls[0][0];
        expect(options.primaryAction).toBeUndefined();
        expect(typeof options.exportItem).toBe('function');
        await f.workbench.destroy();
    });
    it('opens the right-clicked Session and invokes its shared rerun command', async () => {
        const f = setup(); await f.workbench.start();
        await f.workbench.openResource('old');
        const options = (createVFSUI as any).mock.calls.at(-1)[0];
        const menu = options.contextMenu.items({ id: '/target' }, []);
        const action = menu.find((item: any) => item.id === 'rerun-session');
        expect(action.label).toBe(t('session.rerun.title'));
        action.onClick();
        await vi.waitFor(() => expect(f.rerunSession).toHaveBeenCalledOnce());
        expect(f.factory.mock.calls.at(-1)?.[1].target.sessionId).toBe('target');
        expect(f.workbench.getActiveResourceId()).toBe('target?branch=main');
        await f.workbench.destroy();
    });
    it('records branch changes and restores explicit branch routes without navigation loops', async () => {
        const f = setup(); await f.workbench.start();
        await f.workbench.openResource('s');
        expect(f.workbench.getActiveResourceId()).toBe('s?branch=main');
        f.onSelect.mockClear();
        f.manifest.currentBranch = 'review/中文 & notes'; f.changed();
        const route = 's?branch=' + encodeURIComponent(f.manifest.currentBranch);
        await vi.waitFor(() => expect(f.onSelect).toHaveBeenCalledWith(route, 'push'));
        expect(f.factory).toHaveBeenCalledOnce();
        await f.workbench.openResource('s?branch=main');
        expect(f.factory.mock.calls.at(-1)?.[1].target.branch).toBe('main');
        expect(f.workbench.getActiveResourceId()).toBe('s?branch=main');
        await f.workbench.openResource(route);
        expect(f.factory.mock.calls.at(-1)?.[1].target.branch).toBe('review/中文 & notes');
        expect(f.factory).toHaveBeenCalledTimes(3);
        await f.workbench.openResource('s');
        await f.workbench.openResource(route);
        expect(f.factory).toHaveBeenCalledTimes(3);
        expect(f.onSelect.mock.calls.filter(([, mode]) => mode === 'push')).toHaveLength(1);
        await f.workbench.destroy();
    });

    it('does not acquire files or create an editor for an unknown Session', async () => {
        const f = setup(); f.repository.getManifest.mockRejectedValueOnce(new Error('Session missing'));
        await expect(f.workbench.openResource('missing')).rejects.toThrow('missing');
        expect(f.files.acquireFiles).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
        await f.workbench.destroy();
    });
    it('releases its file context when editor creation fails', async () => {
        const f = setup(); f.factory.mockRejectedValueOnce(new Error('editor failed'));
        await expect(f.workbench.openResource('s')).rejects.toThrow('editor failed');
        expect(f.release).toHaveBeenCalledOnce(); await f.workbench.destroy();
    });
    it('destroys a late editor and releases both sources when closed during opening', async () => {
        const f = setup(); let complete!: (editor: any) => void;
        f.factory.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const opening = f.workbench.openResource('s');
        await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
        const closing = f.workbench.destroy(); complete({ destroy: f.destroy });
        await expect(opening).rejects.toThrow('closed'); await closing;
        expect(f.destroy).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
        expect(f.workbench.getActiveResourceId()).toBeNull();
    });
});

it('offers reset only on tasks and cancels through Kernel without deleting history', async () => {
    const f = setup(); await f.workbench.start();
    const options = vi.mocked(createVFSUI).mock.calls.at(-1)![0];
    const defaults = [{ id: 'export', label: 'export' }];
    expect(options.contextMenu!.items!({ id: '/s/files/note.md' } as any, defaults)).toEqual(defaults);
    const menu = options.contextMenu!.items!({ id: '/s/tasks/t' } as any, defaults);
    expect(menu).toHaveLength(1);
    const reset = menu[0] as { onClick: (item: any) => void };
    reset.onClick({}); reset.onClick({});
    await vi.waitFor(() => expect(f.kernel.task).toHaveBeenCalledWith('s', 't'));
    expect(f.kernel.cancel).toHaveBeenCalledTimes(1);
    expect(f.kernel.cancel).toHaveBeenCalledWith('s', 't', expect.stringContaining('强制复位'));
    expect(f.factory).not.toHaveBeenCalled();
    await f.workbench.destroy();
});

it('offers closing a Session while keeping its records', async () => {
    const f = setup(); await f.workbench.start();
    const options = vi.mocked(createVFSUI).mock.calls.at(-1)![0];
    const defaults = [{ id: 'delete', label: '删除' }];
    const items = options.contextMenu!.items!({ id: '/s' } as any, defaults);
    // The destructive defaults stay; closing is additive.
    expect(items.slice(0, defaults.length)).toEqual(defaults);
    const close = items.find(item => (item as { id?: string }).id === 'close-session') as { label?: string; onClick: (item: any) => void };
    expect(close?.label).toBe(t('session.close.action'));
    close.onClick({});

    await vi.waitFor(() => expect(f.kernel.closeSession).toHaveBeenCalledWith('s', true));
    // Closing is not deleting: the Session records are never removed.
    expect(f.repository.getManifest).toHaveBeenCalledWith('s');
    await f.workbench.destroy();
});

it('keeps cleanup failures visible and permits retrying reset', async () => {
    const f = setup();
    f.kernel.task.mockResolvedValueOnce({ effects: { shell: { cleanupPending: true } } } as any);
    await expect((f.workbench as any).resetTask('/s/tasks/t')).rejects.toThrow('仍待清理');
    f.kernel.cancel.mockRejectedValueOnce(new Error('process could not be stopped'));
    await expect((f.workbench as any).resetTask('/s/tasks/t')).rejects.toThrow('process could not be stopped');
    await (f.workbench as any).resetTask('/s/tasks/t');
    expect(f.kernel.cancel).toHaveBeenCalledTimes(3);
    await f.workbench.destroy();
});

it('releases a deleted active Session and replaces its stale route', async () => {
    const f = setup(); await f.workbench.start(); await f.workbench.openResource('s');
    f.repository.getManifest.mockRejectedValueOnce(Object.assign(new Error('Session missing'), { code: 'ENOENT' }));
    f.changed();
    try {
        await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBeNull());
        expect(f.destroy).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
        expect(f.onSelect).toHaveBeenLastCalledWith('', 'replace');
    } finally { await f.workbench.destroy(); }
});

it('retains the active Session when reading its manifest fails without proving deletion', async () => {
    const f = setup(); await f.workbench.start(); await f.workbench.openResource('s');
    const calls = f.repository.getManifest.mock.calls.length;
    f.repository.getManifest.mockRejectedValueOnce(Object.assign(new Error('Storage unavailable'), { code: 'EIO' }));
    f.changed();
    try {
        await vi.waitFor(() => expect(f.repository.getManifest.mock.calls.length).toBeGreaterThan(calls));
        expect(f.workbench.getActiveResourceId()).toBe('s?branch=main');
        expect(f.destroy).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
    } finally { await f.workbench.destroy(); }
});

it('finishes deletion reconciliation before opening a newly selected Session', async () => {
    const f = setup(); await f.workbench.start(); await f.workbench.openResource('s');
    let rejectRead!: (error: Error) => void;
    const read = new Promise<never>((_, reject) => { rejectRead = reject; });
    const calls = f.repository.getManifest.mock.calls.length;
    f.repository.getManifest.mockReturnValueOnce(read);
    f.changed();
    await vi.waitFor(() => expect(f.repository.getManifest.mock.calls.length).toBeGreaterThan(calls));
    const opening = f.workbench.openResource('next');
    rejectRead(Object.assign(new Error('Session missing'), { code: 'ENOENT' }));
    try {
        await opening;
        expect(f.workbench.getActiveResourceId()).toBe('next?branch=main');
        expect(f.destroy).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
        expect(f.onSelect).toHaveBeenLastCalledWith('next?branch=main');
    } finally { await f.workbench.destroy(); }
});

it('reopens the saved branch when the Session route has no branch parameter', async () => {
    const f = setup(); f.manifest.currentBranch = 'branch-8';
    await f.workbench.start();
    await f.workbench.openResource('s');
    expect(f.factory.mock.calls.at(-1)?.[1].target.branch).toBe('branch-8');
    expect(f.workbench.getActiveResourceId()).toBe('s?branch=branch-8');
    await f.workbench.openResource('s?branch=main');
    expect(f.factory.mock.calls.at(-1)?.[1].target.branch).toBe('main');
    await f.workbench.destroy();
});

it('starts the new editor while the sidebar listing is still pending', async () => {
    const f = setup(); await f.workbench.start();
    const sidebar = vi.mocked(createVFSUI).mock.results.at(-1)!.value;
    let release!: () => void;
    sidebar.refresh = () => new Promise<void>(resolve => { release = resolve; });
    const creating = f.workbench.createResource({ initialInputState: { text: 'host goal', agentId: 'chosen' } });
    try {
        await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
        expect(f.factory.mock.calls[0][1].target.sessionId).toBe('new-session');
        expect(f.factory.mock.calls[0][1].initialInputState).toEqual({ text: 'host goal', agentId: 'chosen' });
    } finally {
        release(); await creating; await f.workbench.destroy();
    }
});

it('skips queued intermediate selections and opens the latest while an old factory is pending', async () => {
    const f = setup(); let complete!: (editor: any) => void;
    const oldDestroy = vi.fn(async () => {});
    f.factory.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const old = f.workbench.openResource('old');
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    try {
        const skipped = f.workbench.openResource('skipped');
        const latest = f.workbench.openResource('latest');
        await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('latest?branch=main'));
        await Promise.all([old, skipped, latest]);
        expect(f.repository.getManifest).not.toHaveBeenCalledWith('skipped');
        expect(f.onSelect).not.toHaveBeenCalledWith('old?branch=main');
        expect(f.release).not.toHaveBeenCalled();
    } finally {
        complete({ destroy: oldDestroy }); await f.workbench.destroy();
    }
    expect(oldDestroy).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
});

it('pauses hidden view loads without cancelling Kernel tasks and resumes the requested resource', async () => {
    const f = setup(); await f.workbench.start();
    let complete!: (value: any) => void;
    f.repository.getManifest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const old = f.workbench.openResource('s');
    await vi.waitFor(() => expect(f.repository.getManifest).toHaveBeenCalledWith('s'));
    await f.workbench.setVisible(false); await old;
    expect(f.files.acquireFiles).not.toHaveBeenCalled();
    expect(f.kernel.cancel).not.toHaveBeenCalled();
    expect(f.kernel.closeSession).not.toHaveBeenCalled();
    complete({ id: 's', title: 'Session', currentBranch: 'main' });
    await f.workbench.setVisible(true);
    expect(f.workbench.getActiveResourceId()).toBe('s?branch=main');
    await f.workbench.destroy();
});

it('keeps the editor, active route and file capability when final saving fails, then allows retry', async () => {
    const f = setup(); await f.workbench.openResource('old');
    const editor = await f.factory.mock.results[0].value;
    editor.flushPendingSave = vi.fn().mockRejectedValueOnce(new Error('save failed')).mockResolvedValue(undefined);
    await expect(f.workbench.openResource('new')).rejects.toThrow('save failed');
    expect(f.workbench.getActiveResourceId()).toBe('old?branch=main');
    expect(f.release).not.toHaveBeenCalled();
    expect(f.factory).toHaveBeenCalledOnce();
    await f.workbench.openResource('new');
    expect(f.workbench.getActiveResourceId()).toBe('new?branch=main');
    await f.workbench.destroy();
});

it('flushes edits on hiding while retaining the editor on save failure', async () => {
    const f = setup();
    const flushPendingSave = vi.fn(async () => { throw new Error('offline'); });
    f.factory.mockResolvedValueOnce({ destroy: f.destroy, flushPendingSave } as any);
    await f.workbench.openResource('s');
    await expect(f.workbench.setVisible(false)).rejects.toThrow('offline');
    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled(); expect(f.destroy).not.toHaveBeenCalled();
    await f.workbench.setVisible(true);
    expect(f.workbench.getActiveResourceId()).toBe('s?branch=main');
    flushPendingSave.mockResolvedValue(undefined);
    await f.workbench.destroy();
});
