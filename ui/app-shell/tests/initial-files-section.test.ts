// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { InitialFilesSection, type InitialFilesPort } from '../../app-settings/src/editors/initial-files';

it('shows a collapsed, fully selected file catalog and restores only checked files', async () => {
    const entries = [{ id: 'note', group: 'notes' as const, name: 'demo.md', path: '/home/admin/minds/demo.md', exists: false },
        { id: 'flow', group: 'flows' as const, name: 'essay.flow', path: '/home/admin/flows/essay.flow', exists: true }];
    const port: InitialFilesPort = { list: vi.fn(async () => entries), restore: vi.fn(async ids => {
        entries[0].exists = true; return ids.map(id => ({ id, status: 'restored' as const }));
    }) };
    const container = document.createElement('div'); document.body.append(container);
    const changed = vi.fn(async () => {}), section = new InitialFilesSection(port, changed);
    try {
        await section.mount(container);
        expect([...container.querySelectorAll('details')].every(detail => !detail.open)).toBe(true);
        expect([...container.querySelectorAll<HTMLInputElement>('[data-initial-id]')].every(input => input.checked)).toBe(true);
        expect(container.textContent).toContain('/home/admin/minds/demo.md');
        expect(container.textContent).toContain(t('initialFiles.exists'));
        container.querySelector<HTMLInputElement>('[data-initial-group=notes]')!.click();
        expect(container.querySelector<HTMLInputElement>('[data-initial-id=flow]')!.checked).toBe(true);
        container.querySelector<HTMLInputElement>('[data-initial-group=flows]')!.click();
        expect(container.querySelector<HTMLButtonElement>('[data-initial-restore]')!.disabled).toBe(true);
        container.querySelector<HTMLDetailsElement>('details')!.open = true;
        container.querySelector<HTMLInputElement>('[data-initial-id="note"]')!.click();
        expect(container.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
        expect(container.querySelector<HTMLInputElement>('[data-initial-group=notes]')!.checked).toBe(true);
        container.querySelector<HTMLButtonElement>('[data-initial-restore]')!.click();
        await vi.waitFor(() => expect(container.querySelector('[role=status]')!.textContent).toContain(t('initialFiles.restored')));
        expect(port.restore).toHaveBeenCalledWith(['note']); expect(changed).toHaveBeenCalledOnce();
        expect(container.querySelector<HTMLInputElement>('[data-initial-id="flow"]')!.checked).toBe(false);
    } finally { section.destroy(); container.remove(); }
});
it('reports partial failures, escapes filenames, and releases UI updates when destroyed', async () => {
    const port: InitialFilesPort = { list: async () => [{ id: 'note', group: 'notes', name: '<img src=x>', path: '/demo.md', exists: false }],
        restore: async () => [{ id: 'note', status: 'failed', error: '<script>failed</script>' }] };
    const container = document.createElement('div'); document.body.append(container);
    const section = new InitialFilesSection(port);
    try {
        await section.mount(container); expect(container.querySelector('img')).toBeNull();
        container.querySelector<HTMLButtonElement>('[data-initial-restore]')!.click();
        await vi.waitFor(() => expect(container.querySelector('[role=status]')!.textContent).toContain(t('initialFiles.failed')));
        expect(container.querySelector('script')).toBeNull();
        section.destroy(); expect(container.onclick).toBeNull(); expect(container.onchange).toBeNull();
    } finally { section.destroy(); container.remove(); }
});
