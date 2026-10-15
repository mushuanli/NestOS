// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RecoverySettingsEditor } from '../../app-settings/src/editors/RecoverySettingsEditor';
import type { InitialFilesPort } from '../../app-settings/src/editors/initial-files';
import { t } from '@itookit/common';

const editors: RecoverySettingsEditor[] = [];
afterEach(async () => { for (const editor of editors.splice(0)) await editor.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function fixture() {
    const entries = [{ id: 'note', group: 'notes' as const, name: 'demo.md', path: '/demo.md', exists: false }];
    const port: InitialFilesPort = { list: vi.fn(async () => entries), restore: vi.fn(async ids => {
        entries[0].exists = true; return ids.map(id => ({ id, status: 'restored' as const }));
    }) };
    const items = [{ type: 'provider' as const, id: 'one', name: 'One', status: 'modified' as const }];
    const service = { getRestorableItems: vi.fn(async () => items), restoreItem: vi.fn(async () => {}), resetAllDefaults: vi.fn(async () => {}) };
    const container = document.createElement('div'); document.body.append(container);
    const editor = new RecoverySettingsEditor(container, service as never, {} as never, undefined, port);
    editors.push(editor); await editor.render(); return { editor, container, port, service };
}
function click(container: ParentNode, selector: string) { container.querySelector<HTMLElement>(selector)!.click(); }
async function confirm() { click(document, '.settings-modal-confirm'); await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull()); }

it('uses one page action for selected files and configurations, without fetching on selection', async () => {
    const { container, service, port } = await fixture();
    expect(container.querySelector('[data-initial-restore]')).toBeNull();
    expect(container.querySelector('[data-initial-refresh]')).toBeNull();
    expect(container.querySelector('#btn-batch-restore')!.textContent).toBe(t('recovery.restoreSelected', { count: 1 }));
    click(container, '.chk-select-all');
    expect(service.getRestorableItems).toHaveBeenCalledOnce(); expect(port.list).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLInputElement>('.chk-item')!.checked).toBe(true);
    expect(container.querySelector('#btn-batch-restore')!.textContent).toBe(t('recovery.restoreSelected', { count: 2 }));
    click(container, '#btn-batch-restore');
    expect(document.querySelector('.settings-modal__body')!.textContent).toContain(t('recovery.confirmSelection', { files: 1, configurations: 1 }));
    expect(document.querySelector('.settings-modal__body')!.textContent).toContain(t('recovery.configurationHelp'));
    await confirm();
    expect(port.restore).toHaveBeenCalledWith(['note']); expect(service.restoreItem).toHaveBeenCalledWith('provider', 'one');
    expect(service.resetAllDefaults).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('.chk-item')!.checked).toBe(false);
    expect(container.querySelector('[role=status]')!.textContent).toContain(t('initialFiles.restored'));
});

it('refreshes every group while retaining selection and expanded files', async () => {
    const { container, service, port } = await fixture();
    click(container, '.chk-item'); const details = container.querySelector('details')!; details.open = true;
    click(container, '[data-initial-all]'); click(container, '#btn-refresh-recovery');
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('#btn-refresh-recovery')!.disabled).toBe(false));
    expect(service.getRestorableItems).toHaveBeenCalledTimes(2); expect(port.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('.chk-item')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-initial-id]')!.checked).toBe(false);
    expect(container.querySelector('details')!.open).toBe(true);
    expect(port.restore).not.toHaveBeenCalled(); expect(service.restoreItem).not.toHaveBeenCalled();
});

it('retains failed configurations for retry and locks every selection while restoring', async () => {
    const { container, service, port } = await fixture();
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    service.restoreItem.mockImplementationOnce(async () => { await pending; throw new Error('write denied'); });
    click(container, '.chk-item'); click(container, '#btn-batch-restore'); click(document, '.settings-modal-confirm');
    await vi.waitFor(() => expect(service.restoreItem).toHaveBeenCalledOnce());
    expect([...container.querySelectorAll<HTMLInputElement>('input')].every(input => input.disabled)).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('#btn-reset-all')!.disabled).toBe(true);
    finish(); await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
    expect(container.querySelector<HTMLInputElement>('.chk-item')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('.chk-item')!.disabled).toBe(false);
    expect(port.restore).toHaveBeenCalledOnce();
    expect(document.querySelector('.settings-toast--warning')!.textContent).toContain(t('recovery.partialFailure', { count: 1 }));
});

it('keeps full configuration reset independent from file restoration', async () => {
    const { container, service, port } = await fixture();
    click(container, '#btn-reset-all');
    expect(document.querySelector('.settings-modal__body')!.textContent).toContain(t('recovery.resetHelp'));
    await confirm();
    expect(service.resetAllDefaults).toHaveBeenCalledOnce(); expect(port.restore).not.toHaveBeenCalled();
    expect(service.restoreItem).not.toHaveBeenCalled();
});
