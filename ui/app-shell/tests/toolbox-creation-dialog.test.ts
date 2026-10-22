// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolboxDrawers } from '@itookit/app-contracts/services';
import { getLogger, t } from '@itookit/common';
import { showToolboxCreationDialog, type ToolboxCreationDraft } from '../src/toolbox/create-resource-dialog';

let controller: AbortController;
beforeEach(() => {
    controller = new AbortController();
    getLogger().clear();
    HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function () { this.removeAttribute('open'); };
});
afterEach(() => { controller.abort(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup(overrides: Partial<Parameters<typeof showToolboxCreationDialog>[0]> = {}) {
    const save = vi.fn(async (_draft: ToolboxCreationDraft) => '/providers/created');
    const open = vi.fn(async (_path: string) => {});
    const pending = showToolboxCreationDialog({ kinds: ['providers'], drawers: { list: () => [] } as unknown as ToolboxDrawers,
        templates: [{ id: 'one', name: 'Provider One' }, { id: 'two', name: 'Provider Two' }], providers: [], signal: controller.signal,
        save, open, ...overrides });
    const dialog = document.querySelector<HTMLDialogElement>('.toolbox-create')!, form = dialog.querySelector('form')!;
    const input = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!, name = dialog.querySelector<HTMLInputElement>('[name="resourceName"]')!;
    const choose = (id = 'one') => { input.click(); dialog.querySelector<HTMLButtonElement>(`[data-template-id="${id}"]`)!.click(); };
    return { pending, dialog, form, input, name, choose, save, open };
}

it('requires a provider name and treats a name outside the catalog as custom', async () => {
    const f = setup();
    expect(document.activeElement).toBe(f.input);
    expect(f.input.compareDocumentPosition(f.name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.name.closest('label')?.hidden).toBe(true);
    f.form.requestSubmit(); expect(f.save).not.toHaveBeenCalled();
    expect(f.input.validationMessage).toBe(t('provider.template.required'));
    f.input.value = 'Gateway'; f.input.dispatchEvent(new Event('input'));
    expect(f.dialog.querySelector('[role="status"]')?.textContent).toBe(t('provider.template.empty'));
    f.dialog.querySelector<HTMLButtonElement>('[data-template-id="custom"]')!.click();
    expect(f.dialog.textContent).toContain(t('provider.template.customHelp'));
    f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gateway', providerTemplateId: undefined }));
});

it('marks existing providers as added and rejects typed duplicate names while skipping disabled keyboard options', async () => {
    const f = setup({providers: [{id: 'one', name: 'Renamed One'}, {id: 'gateway', name: 'My gateway'}]});
    f.input.click();
    const added = f.dialog.querySelector<HTMLButtonElement>('[data-template-id="one"]')!;
    expect(added.disabled).toBe(true); expect(added.textContent).toContain(t('provider.template.added'));
    for (const key of ['ArrowDown', 'Enter']) f.input.dispatchEvent(new KeyboardEvent('keydown', {key, cancelable: true}));
    expect(f.input.value).toBe('Provider Two');
    f.input.value = 'Provider One'; f.input.dispatchEvent(new Event('input'));
    f.form.requestSubmit(); expect(f.save).not.toHaveBeenCalled(); expect(f.input.validationMessage).toBe(t('provider.template.exists'));
    f.input.value = '  MY gateway '; f.input.dispatchEvent(new Event('input'));
    f.form.requestSubmit(); expect(f.save).not.toHaveBeenCalled(); expect(f.input.checkValidity()).toBe(false);
    f.input.value = 'New gateway'; f.input.dispatchEvent(new Event('input'));
    f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({name: 'New gateway', providerTemplateId: undefined}));
});

it('uses catalog names directly and leaves IME candidate keys alone', async () => {
    const f = setup();
    const composing = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, cancelable: true });
    f.input.dispatchEvent(composing); expect(composing.defaultPrevented).toBe(false);
    expect(f.input.hasAttribute('aria-activedescendant')).toBe(false);
    for (const key of ['ArrowDown', 'Enter']) f.input.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    expect(f.input.value).toBe('Provider One'); expect(f.input.getAttribute('aria-expanded')).toBe('false');
    f.choose('two'); expect(f.input.value).toBe('Provider Two');
    f.input.value = 'One'; f.input.dispatchEvent(new Event('input'));
    expect(f.input.checkValidity()).toBe(true);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    f.input.dispatchEvent(escape); expect(escape.defaultPrevented).toBe(true);
    expect(f.input.getAttribute('aria-expanded')).toBe('false'); expect(f.dialog.isConnected).toBe(true);
    f.choose(); f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Provider One', providerTemplateId: 'one' }));
});

it('recognizes a typed catalog name and submits its canonical name without another name field', async () => {
    const f = setup(); f.input.value = '  provider two  '; f.input.dispatchEvent(new Event('input'));
    expect(f.name.disabled).toBe(true); expect(f.name.closest('label')?.hidden).toBe(true);
    f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Provider Two', providerTemplateId: 'two' }));
});

it('keeps the draft editable after a save failure and logs the specific safe error code', async () => {
    const f = setup(); f.choose();
    f.save.mockRejectedValueOnce(Object.assign(new Error('Insufficient storage; private-request-body'), { code: 'STORAGE_FULL' }));
    f.form.requestSubmit();
    await vi.waitFor(() => expect(f.dialog.querySelector('[role="alert"]')?.textContent).toContain('Insufficient storage'));
    expect(f.dialog.querySelector('fieldset')!.disabled).toBe(false);
    const logs = getLogger().query({ modules: ['toolbox-create'] });
    expect(logs).toContainEqual(expect.objectContaining({ message: 'toolbox.resource.create.failed', data: expect.objectContaining({ stage: 'persistence', code: 'STORAGE_FULL', operationId: expect.any(String) }) }));
    expect(JSON.stringify(logs)).not.toContain('private-request-body');
    f.input.value = 'Retry account'; f.input.dispatchEvent(new Event('input')); f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Retry account' }));
});

it('retries opening a persisted resource without creating another copy', async () => {
    const f = setup({ kinds: ['providers', 'flows'], initialKind: 'providers' }); f.choose(); f.open.mockRejectedValueOnce(new Error('Navigation unavailable'));
    f.form.requestSubmit();
    await vi.waitFor(() => expect(f.dialog.querySelector('button[type="submit"]')?.textContent).toBe(t('toolbox.retryOpen')));
    expect(f.dialog.querySelector('[role="alert"]')?.textContent).toContain(t('toolbox.createdOpenFailed'));
    expect(f.dialog.querySelector('fieldset')!.disabled).toBe(true);
    expect(f.dialog.querySelector<HTMLButtonElement>('.toolbox-create__back')!.disabled).toBe(true);
    f.form.requestSubmit(); expect(await f.pending).toBe('/providers/created');
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.open).toHaveBeenCalledTimes(2);
});

it('does not open a resource when the workspace closes during persistence', async () => {
    let finish!: (path: string) => void;
    const f = setup(); f.choose(); f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.form.requestSubmit(); controller.abort(); expect(await f.pending).toBe('');
    finish('/providers/created'); await vi.waitFor(() => expect(f.save).toHaveResolved());
    expect(f.open).not.toHaveBeenCalled(); expect(document.querySelector('.toolbox-create')).toBeNull();
});

it('requires a resource type before showing fields and disables inactive provider validation', async () => {
    const f = setup({ kinds: ['providers', 'flows'] });
    expect(document.activeElement).toBe(f.dialog.querySelector('[data-create-kind="providers"]'));
    expect(f.dialog.querySelector('fieldset')?.hidden).toBe(true);
    expect(f.name.disabled).toBe(true);
    f.dialog.querySelector<HTMLButtonElement>('[data-create-kind="flows"]')!.click();
    f.name.value = 'My flow'; expect(f.input.disabled).toBe(true);
    f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'flows', name: 'My flow', providerTemplateId: undefined }));
});

it('returns to the type chooser and restores each resource type draft independently', async () => {
    const f = setup({ kinds: ['providers', 'flows'] });
    const chooseKind = (kind: string) => f.dialog.querySelector<HTMLButtonElement>(`[data-create-kind="${kind}"]`)!.click();
    const back = () => f.dialog.querySelector<HTMLButtonElement>('.toolbox-create__back')!.click();
    chooseKind('providers'); f.input.value = 'Work account'; f.input.dispatchEvent(new Event('input')); back();
    expect(f.dialog.querySelector('fieldset')?.hidden).toBe(true);
    expect(f.dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.hidden).toBe(true);
    chooseKind('flows'); expect(f.name.value).toBe('');
    f.name.value = 'Daily summary'; f.dialog.querySelector<HTMLInputElement>('[name="drawer"]')!.value = 'Workflows'; back();
    chooseKind('providers'); expect(f.input.value).toBe('Work account'); back();
    chooseKind('flows'); expect(f.name.value).toBe('Daily summary');
    expect(f.dialog.querySelector<HTMLInputElement>('[name="drawer"]')?.value).toBe('Workflows');
    f.form.requestSubmit(); await f.pending;
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'flows', name: 'Daily summary', drawer: 'Workflows' }));
});

it('explains the missing provider prerequisite and prevents creating an orphan connection', async () => {
    const f = setup({ kinds: ['connections'] });
    expect(f.dialog.textContent).toContain(t('toolbox.connectionNeedsProvider'));
    expect(f.dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    f.name.value = 'Orphan'; f.form.requestSubmit(); expect(f.save).not.toHaveBeenCalled();
    controller.abort(); await f.pending;
});

it('hosts model details outside the creation form and keeps failed completion editable', async () => {
    let done!: () => Promise<void>;
    const handle = { flush: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const f = setup({ configure: async (container, _path, complete) => {
        done = complete; container.append(document.createElement('form')); return handle;
    } });
    f.choose(); f.form.requestSubmit();
    await vi.waitFor(() => expect(f.dialog.classList.contains('toolbox-create--setup')).toBe(true));
    expect(f.form.hidden).toBe(true); expect(f.dialog.querySelector('section form')?.closest('section')?.parentElement).toBe(f.dialog);
    expect(f.open).not.toHaveBeenCalled();
    handle.dispose.mockRejectedValueOnce(new Error('Save still pending'));
    await done(); expect(f.dialog.isConnected).toBe(true);
    expect(f.dialog.textContent).toContain('Save still pending');
    await done(); expect(await f.pending).toBe('/providers/created');
    expect(handle.flush).toHaveBeenCalledTimes(2); expect(handle.dispose).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
});

it('retries loading model details without creating a second provider', async () => {
    let done!: () => Promise<void>;
    const configure = vi.fn(async (_container: HTMLElement, _path: string, complete: () => Promise<void>) => {
        done = complete; return { flush: async () => {}, dispose: async () => {} };
    }).mockRejectedValueOnce(new Error('Details unavailable'));
    const f = setup({ configure }); f.choose(); f.form.requestSubmit();
    await vi.waitFor(() => expect(f.dialog.querySelector('button[type="submit"]')?.textContent).toBe(t('toolbox.retryOpen')));
    expect(f.dialog.textContent).toContain('Details unavailable');
    f.form.requestSubmit(); await vi.waitFor(() => expect(f.dialog.classList.contains('toolbox-create--setup')).toBe(true));
    await done(); await f.pending;
    expect(f.save).toHaveBeenCalledTimes(1); expect(configure).toHaveBeenCalledTimes(2);
});

it('keeps nested confirmations and toast portals above the native dialog and restores them on close', async () => {
    let done!: () => Promise<void>;
    const f = setup({ configure: async (_container, _path, complete) => {
        done = complete; return { flush: async () => {}, dispose: async () => {} };
    } });
    f.choose(); f.form.requestSubmit();
    await vi.waitFor(() => expect(f.dialog.classList.contains('toolbox-create--setup')).toBe(true));
    const overlay = document.createElement('div'); overlay.className = 'settings-modal-overlay';
    const cancel = document.createElement('button'); cancel.className = 'settings-modal-cancel'; cancel.onclick = vi.fn(); overlay.append(cancel);
    const toast = document.createElement('div'); toast.className = 'settings-toast-container'; document.body.append(overlay, toast);
    await vi.waitFor(() => expect(f.dialog.contains(overlay)).toBe(true));
    expect(f.dialog.contains(toast)).toBe(true);
    f.dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(cancel.onclick).toHaveBeenCalled(); expect(f.dialog.isConnected).toBe(true);
    await done(); await f.pending;
    expect(overlay.isConnected).toBe(false); expect(toast.parentElement).toBe(document.body);
});
