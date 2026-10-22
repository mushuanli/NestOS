// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorOptions, IEditor } from '@itookit/ui-common';
import { configureCreatedModel } from '../src/toolbox/creation-model-setup';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup() {
    const dialog = document.createElement('dialog'), creationForm = document.createElement('form'), container = document.createElement('section');
    dialog.append(creationForm, container); document.body.append(dialog);
    const editors: Array<{ flushPendingSave: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
    const factory = vi.fn(async (element: HTMLElement, _options: EditorOptions) => {
        element.innerHTML = '<form><input name="providerSetting"></form>';
        const editor = { flushPendingSave: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(async () => { element.replaceChildren(); }), isDirty: () => false };
        editors.push(editor); return editor as unknown as IEditor;
    });
    const connections = new Map<string, { providerId: string; enabled: boolean }>();
    const providers = new Map([['p', {}], ['work/provider', {}]]);
    const source = { driver: { writeContent: vi.fn().mockResolvedValue(undefined) } };
    const stop = vi.fn(), subscribe = vi.fn(() => stop);
    const navigation = vi.fn(async () => ({ directories: [{ path: '/connections', nodes: [...connections.keys()].map(id => ({ path: '/connections/' + encodeURIComponent(id), name: 'Connection ' + id })) }] }));
    const create = vi.fn(async (_kind: string, _name: string, providerId: string) => { connections.set('new/id', { providerId, enabled: true }); return '/connections/new%2Fid'; });
    const resources = { sources: { providers: source, connections: source }, navigation, subscribe, create };
    const options = { factories: { providers: factory, connections: factory }, resources: resources as never,
        inventory: { connections, providers } as never, navigate: vi.fn().mockResolvedValue(undefined), done: vi.fn().mockResolvedValue(undefined), signal: new AbortController().signal };
    return { container, creationForm, options, editors, factory, connections, providers, source, create, stop };
}

it('mounts existing settings in the dialog outside its creation form and keeps model navigation inside', async () => {
    const f = setup(); f.connections.set('existing', { providerId: 'work/provider', enabled: true });
    const handle = await configureCreatedModel(f.container, '/providers/work%2Fprovider', f.options);
    expect(f.factory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ target: { kind: 'entity', entityType: 'provider', id: 'work/provider' }, files: { fs: f.source, cwd: '/' } }));
    expect(f.creationForm.querySelector('form')).toBeNull(); expect(f.container.querySelector('form form')).toBeNull();
    expect(f.container.querySelector('[data-connection-id="existing"]')!.textContent).toBe('Connection existing');
    const config = f.factory.mock.calls[0][1];
    await config.hostContext!.navigate({ target: 'toolbox', resourceId: '/connections/existing' });
    expect(f.options.navigate).not.toHaveBeenCalled(); expect(f.editors[0].flushPendingSave).toHaveBeenCalled(); expect(f.editors[0].destroy).toHaveBeenCalledOnce();
    expect(f.factory).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ target: { kind: 'entity', entityType: 'connection', id: 'existing' } }));
    f.container.querySelector<HTMLButtonElement>('[data-action="complete-setup"]')!.click();
    await vi.waitFor(() => expect(f.options.done).toHaveBeenCalledOnce());
    await handle.dispose(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.editors[1].destroy).toHaveBeenCalledOnce();
});

it('creates a scoped model connection from an inline sibling form and mounts its editor', async () => {
    const f = setup(), handle = await configureCreatedModel(f.container, '/providers/work%2Fprovider', f.options);
    f.container.querySelector<HTMLButtonElement>('[data-action="setup-create-connection"]')!.click();
    const form = f.container.querySelector<HTMLFormElement>('.toolbox-create__connection-form')!;
    await vi.waitFor(() => expect(form.hidden).toBe(false));
    form.querySelector<HTMLInputElement>('[name="connectionName"]')!.value = ' ';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(f.create).not.toHaveBeenCalled();
    form.querySelector<HTMLInputElement>('[name="connectionName"]')!.value = 'Work model';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledWith('connections', 'Work model', 'work/provider'));
    await vi.waitFor(() => expect(f.factory).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ target: { kind: 'entity', entityType: 'connection', id: 'new/id' } })));
    expect(form.closest('form form')).toBeNull(); expect(f.options.navigate).not.toHaveBeenCalled();
    expect(f.container.querySelector('[data-connection-id="new/id"]')).not.toBeNull();
    await handle.dispose();
});

it('retries a failed connection editor mount without creating another saved connection', async () => {
    const f = setup(), handle = await configureCreatedModel(f.container, '/providers/p', f.options);
    f.factory.mockRejectedValueOnce(new Error('Editor unavailable'));
    f.container.querySelector<HTMLButtonElement>('[data-action="setup-create-connection"]')!.click();
    const form = f.container.querySelector<HTMLFormElement>('.toolbox-create__connection-form')!;
    await vi.waitFor(() => expect(form.hidden).toBe(false));
    form.querySelector<HTMLInputElement>('input')!.value = 'Connection'; form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(f.container.querySelector('[role="alert"]')!.textContent).toContain('Editor unavailable'));
    expect(f.editors[0].destroy).not.toHaveBeenCalled();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledTimes(3));
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.editors[0].destroy).toHaveBeenCalledOnce();
    await handle.dispose();
});

it('retains the current editor when pending configuration cannot save', async () => {
    const f = setup(), handle = await configureCreatedModel(f.container, '/providers/p', f.options);
    f.editors[0].flushPendingSave.mockRejectedValueOnce(new Error('Invalid API address'));
    f.container.querySelector<HTMLButtonElement>('[data-action="setup-create-connection"]')!.click();
    await vi.waitFor(() => expect(f.container.querySelector('[role="alert"]')!.textContent).toContain('Invalid API address'));
    expect(f.container.querySelector<HTMLFormElement>('.toolbox-create__connection-form')!.hidden).toBe(true);
    expect(f.editors[0].destroy).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    await handle.dispose();
});

it('cleans initialization failures and rejects a mount inside a parent form', async () => {
    const f = setup(); f.factory.mockRejectedValueOnce(new Error('Initialization failed'));
    await expect(configureCreatedModel(f.container, '/providers/p', f.options)).rejects.toThrow('Initialization failed');
    expect(f.container.childElementCount).toBe(0); expect(f.options.resources.subscribe).not.toHaveBeenCalled();
    f.creationForm.append(f.container);
    await expect(configureCreatedModel(f.container, '/providers/p', f.options)).rejects.toThrow('outside the creation form');
    expect(f.factory).toHaveBeenCalledOnce();
});

it('retains the editor and subscription when disposal fails so the caller can retry', async () => {
    const f = setup(), handle = await configureCreatedModel(f.container, '/providers/p', f.options);
    f.editors[0].destroy.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(handle.dispose()).rejects.toThrow('Storage unavailable');
    expect(f.stop).not.toHaveBeenCalled(); expect(f.container.querySelector('[name="providerSetting"]')).not.toBeNull();
    await handle.flush(); expect(f.editors[0].flushPendingSave).toHaveBeenCalled();
    await handle.dispose(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.container.childElementCount).toBe(0);
});

it.each(['providers', 'connections'] as const)('discards the creation result when the original %s resource is deleted', async kind => {
    const f = setup(); f.connections.set('p', { providerId: 'p', enabled: true });
    const requestDelete = vi.fn(async () => { (kind === 'providers' ? f.providers : f.connections).delete('p'); });
    const handle = await configureCreatedModel(f.container, '/' + kind + '/p', { ...f.options, requestDelete });
    const targets = [{ kind: 'entity' as const, entityType: kind === 'providers' ? 'provider' as const : 'connection' as const, id: 'p' }];
    await f.factory.mock.calls[0][1].hostContext!.requestDelete!(targets);
    expect(requestDelete).toHaveBeenCalledWith(targets); expect(f.options.done).toHaveBeenCalledWith(true);
    await handle.dispose();
});

it('returns to the original Provider after deleting only the current connection', async () => {
    const f = setup(); f.connections.set('c', { providerId: 'p', enabled: true });
    const requestDelete = vi.fn(async () => { f.connections.delete('c'); });
    const handle = await configureCreatedModel(f.container, '/providers/p', { ...f.options, requestDelete });
    await f.factory.mock.calls[0][1].hostContext!.navigate({ target: 'toolbox', resourceId: '/connections/c' });
    await f.factory.mock.calls[1][1].hostContext!.requestDelete!([{ kind: 'entity', entityType: 'connection', id: 'c' }]);
    expect(f.factory).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ target: { kind: 'entity', entityType: 'provider', id: 'p' } }));
    expect(f.options.done).not.toHaveBeenCalled(); expect(f.options.navigate).not.toHaveBeenCalled();
    await handle.dispose();
});

it('keeps the current connection when deletion is cancelled', async () => {
    const f = setup(); f.connections.set('c', { providerId: 'p', enabled: true });
    const requestDelete = vi.fn().mockResolvedValue(undefined);
    const handle = await configureCreatedModel(f.container, '/connections/c', { ...f.options, requestDelete });
    await f.factory.mock.calls[0][1].hostContext!.requestDelete!([{ kind: 'entity', entityType: 'connection', id: 'c' }]);
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.options.done).not.toHaveBeenCalled();
    await handle.dispose();
});
