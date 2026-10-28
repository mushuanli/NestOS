// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DigitalTwinService } from '@itookit/app-core';
import { createVFS, MemoryBackend, FSError } from '@itookit/vfs-core';
import { TwinWorkbench } from '../src/digital-twin';
import { VFS_DOM_EVENTS } from '@itookit/vfs-ui';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); });
async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    const run = vi.fn(async (job, text, attached) => { await attached('task'); return { candidates: [], tokens: 10 }; });
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), defaultConnection: async () => 'first',
        connectionFingerprint: async id => id, deleteSession: async () => {},
        reader: { sessions: async () => [], read: async () => ({ text: 'Mail', hash: 'mail', nativeIdentity: 'mail' }),
            discover: async () => ({ projects: ['p'], completeScopes: ['p/file'], errors: [],
                resources: [{ kind: 'file', projectId: 'p', path: 'mail.email', target: 'mail.email', label: 'Mail' }] }) },
        extractor: { run, cancel: async () => {}, cleanup: async () => {} } });
    cleanup.push(() => service.dispose());
    await service.scanOnce();
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, selected: vi.fn(),
        connections: async () => [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }, { id: 'third', name: 'Third' }] });
    cleanup.push(() => workbench.destroy());
    await workbench.start(); await workbench.openResource('/sources');
    const control = <T extends HTMLElement>(name: string) => editor.querySelector<T>(`[data-form=settings] [name=${name}]`)!;
    const state = () => editor.querySelector<HTMLElement>('[data-save-status]')!.dataset.state;
    return { service, workbench, sidebar, editor, control, state, run };
}
it('saves model selection without submit, preserves focus and dispatches through the new model', async () => {
    const host = await setup(), model = host.control<HTMLSelectElement>('connectionId');
    const overview = vi.spyOn(host.service, 'snapshot');
    expect(host.editor.querySelector('[data-form=settings] [type=submit]')).toBeNull();
    model.focus(); model.value = 'second'; model.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('saved'));
    expect(document.activeElement).toBe(model);
    expect(overview).not.toHaveBeenCalled();
    const snapshot = await host.service.snapshot();
    expect(snapshot.settings.data.connectionId).toBe('second');
    expect(snapshot.scans.plans.every(plan => plan.data.connectionId === 'second')).toBe(true);
    await host.service.scanOnce();
    expect(host.run.mock.calls.at(-1)![0].connectionId).toBe('second');
});
it('serializes rapid changes while a save is in flight and flushes text before navigation', async () => {
    const host = await setup(), model = host.control<HTMLSelectElement>('connectionId');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const configure = host.service.configure.bind(host.service);
    const save = vi.spyOn(host.service, 'configure').mockImplementationOnce(async (...args) => { await waiting; await configure(...args); });
    model.value = 'second'; model.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    model.value = 'third'; model.dispatchEvent(new Event('change', { bubbles: true }));
    const name = host.control<HTMLInputElement>('userName'); name.value = 'Alice'; name.dispatchEvent(new Event('input', { bubbles: true }));
    const navigation = host.workbench.openResource('/overview'); release(); await navigation;
    expect((await host.service.snapshot()).settings.data).toMatchObject({ connectionId: 'third', userName: 'Alice' });
    expect(host.workbench.getActiveResourceId()).toBe('/overview');
});
it('retains invalid input, blocks navigation until corrected, and saves only the edited field', async () => {
    const host = await setup(), ignore = host.control<HTMLTextAreaElement>('globalExclude');
    ignore.value = '!invalid'; ignore.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('failed'));
    expect(ignore.value).toBe('!invalid');
    expect(host.editor.querySelector<HTMLButtonElement>('[data-action=retrySettings]')!.hidden).toBe(false);
    await host.workbench.openResource('/overview'); expect(host.workbench.getActiveResourceId()).toBe('/sources');
    const snapshot = await host.service.snapshot(); await host.service.configure({ paused: true }, snapshot.settings.revision);
    ignore.value = '**/*.log'; ignore.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('saved'));
    expect((await host.service.snapshot()).settings.data).toMatchObject({ paused: true, globalExclude: ['**/*.log'] });
});
it('groups budget with the model, persists unlimited mode and restores the previous limit', async () => {
    const host = await setup(), toggle = host.control<HTMLInputElement>('budgetUnlimited');
    const amount = host.control<HTMLInputElement>('tokenLimit');
    expect(amount.closest('section')).toBe(host.control<HTMLSelectElement>('connectionId').closest('section'));
    toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('saved'));
    expect((await host.service.getSettings()).data).toMatchObject({ budgetUnlimited: true, tokenLimit: 100000 });
    expect(amount.disabled).toBe(true);
    expect(host.editor.querySelector<HTMLElement>('[data-budget-limit]')!.hidden).toBe(true);
    await host.workbench.openResource('/sources');
    expect(host.control<HTMLInputElement>('budgetUnlimited').checked).toBe(true);
    const restored = host.control<HTMLInputElement>('budgetUnlimited');
    restored.checked = false; restored.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('saved'));
    expect(host.control<HTMLInputElement>('tokenLimit').disabled).toBe(false);
    expect((await host.service.getSettings()).data).toMatchObject({ budgetUnlimited: false, tokenLimit: 100000 });
});

it('persists unlimited mode after HTTP conflicts in both reading and saving settings', async () => {
    const host = await setup();
    const read = vi.spyOn(host.service, 'getSettings').mockRejectedValueOnce(new FSError('ECONFLICT', 'read changed'));
    const save = vi.spyOn(host.service, 'configure').mockRejectedValueOnce(new FSError('ECONFLICT', 'commit changed'));
    try {
        const toggle = host.control<HTMLInputElement>('budgetUnlimited');
        toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(host.state()).toBe('saved'));
        expect((await host.service.getSettings()).data.budgetUnlimited).toBe(true);
        expect(save).toHaveBeenCalledTimes(2);
    } finally { read.mockRestore(); save.mockRestore(); }
});

it('uses the shared VFS list for navigation, deep links and mobile activation', async () => {
    const host = await setup();
    const rows = () => [...host.sidebar.querySelectorAll<HTMLElement>('[data-item-type="file"]')];
    expect(rows().map(row => row.dataset.itemId)).toEqual(['/overview', '/profile', '/memories', '/goals', '/sources', '/runs']);
    expect(host.sidebar.querySelector('[data-page]')).toBeNull();
    expect(host.sidebar.querySelector('[data-action="item-menu"]')).toBeNull();
    expect(rows().every(row => !row.draggable)).toBe(true);
    await host.workbench.openResource('/sources/runs');
    expect(host.sidebar.querySelector('[data-item-id="/sources"] .is-active')).not.toBeNull();
    const activated = vi.fn(); host.sidebar.addEventListener(VFS_DOM_EVENTS.resourceActivated, activated);
    const name = host.control<HTMLInputElement>('userName');
    name.value = 'Alice'; name.dispatchEvent(new Event('input', { bubbles: true }));
    host.sidebar.querySelector<HTMLElement>('[data-item-id="/overview"] [data-action="select-and-open"]')!.click();
    await vi.waitFor(() => expect(host.workbench.getActiveResourceId()).toBe('/overview'));
    expect((await host.service.getSettings()).data.userName).toBe('Alice');
    expect(activated).toHaveBeenCalled();
});

it('restores the previous VFS navigation selection when settings cannot be saved', async () => {
    const host = await setup(), ignore = host.control<HTMLTextAreaElement>('globalExclude');
    ignore.value = '!invalid'; ignore.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('failed'));
    host.sidebar.querySelector<HTMLElement>('[data-item-id="/overview"] [data-action="select-and-open"]')!.click();
    await vi.waitFor(() => expect(host.sidebar.querySelector('[data-item-id="/sources"] .is-active')).not.toBeNull());
    expect(host.workbench.getActiveResourceId()).toBe('/sources');
    expect(host.control<HTMLTextAreaElement>('globalExclude')).toBe(ignore);
    ignore.value = ''; ignore.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.state()).toBe('saved'));
});
