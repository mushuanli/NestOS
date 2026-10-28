// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {DigitalTwinService} from '@itookit/app-core';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {bindTwinWorkspaces} from '../../../backend/app-core/src/digital-twin/workspaces';
import {TwinWorkbench} from '../src/digital-twin';
it('switches only the current view to an authorized organization handle and makes viewers read-only', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/');
    const dependencies = {fs, reader: {sessions: async () => [], read: async () => ({text: '', hash: '', nativeIdentity: ''})},
        extractor: {run: async () => ({candidates: [], tokens: 0}), cancel: async () => {}, cleanup: async () => {}}, deleteSession: async () => {}};
    const personal = new DigitalTwinService(dependencies);
    const owner = new DigitalTwinService({...dependencies, workspace: {twinId: 'team', ownerId: 'org:team', name: 'Team', kind: 'organization', authorize: async () => {}}});
    const viewer = new DigitalTwinService({...dependencies, workspace: {twinId: 'team', ownerId: 'org:team', name: 'Team', kind: 'organization', readOnly: true, authorize: async () => {}}});
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    await owner.addMemory({content: 'Team knowledge'}); bindTwinWorkspaces([personal, viewer]);
    const view = new TwinWorkbench({service: personal, sidebar, editor, connections: async () => [], selected() {}});
    try {
        await view.start();
        const select = editor.querySelector<HTMLSelectElement>('[data-twin-workspace]')!; select.value = 'team'; select.dispatchEvent(new Event('change', {bubbles: true}));
        const {vi} = await import('vitest');
        await vi.waitFor(() => expect(editor.textContent).toContain('Team knowledge'));
        expect(editor.querySelector<HTMLSelectElement>('[data-twin-workspace]')!.value).toBe('team');
        expect((await personal.snapshot()).memories).toHaveLength(0);
        await view.openResource('/sources');
        expect(editor.querySelector<HTMLInputElement>('[data-form=scanPlan] [name=name]')!.disabled).toBe(true);
        await view.openResource('/memories');
        expect(editor.querySelector<HTMLButtonElement>('[data-action=forget]')!.disabled).toBe(true);
        await expect(viewer.addMemory({content: 'Denied'})).rejects.toThrow('TWIN_WORKSPACE_READ_ONLY');
    } finally {await view.destroy(); await viewer.dispose(); await owner.dispose(); await personal.dispose(); await manager.dispose(); sidebar.remove(); editor.remove();}
});
