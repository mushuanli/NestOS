// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { InitialFilesSection, type InitialFilesPort } from '../../app-settings/src/editors/initial-files';

it('shows a collapsed, unselected file catalog and restores only checked files', async () => {
    const entries = [{ id: 'note', group: 'notes' as const, name: 'demo.md', path: '/home/admin/notes/demo.md', exists: false },
        { id: 'flow', group: 'flows' as const, name: 'essay.flow', path: '/home/admin/flows/essay.flow', exists: true }];
    const port: InitialFilesPort = { list: vi.fn(async () => entries), restore: vi.fn(async ids => {
        entries[0].exists = true; return ids.map(id => ({ id, status: 'restored' as const }));
    }) };
    const container = document.createElement('div'); document.body.append(container);
    const changed = vi.fn(async () => {}), section = new InitialFilesSection(port, changed);
    try {
        await section.mount(container);
        expect([...container.querySelectorAll('details')].every(detail => !detail.open)).toBe(true);
        expect([...container.querySelectorAll<HTMLInputElement>('[data-initial-id], [data-initial-group]')].every(input => !input.checked)).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('[data-initial-restore]')!.disabled).toBe(true);
        expect(container.textContent).toContain('/home/admin/notes/demo.md');
        expect(container.textContent).toContain(t('initialFiles.exists'));
        container.querySelector<HTMLInputElement>('[data-initial-group=flows]')!.click();
        expect(container.querySelector<HTMLInputElement>('[data-initial-id=flow]')!.checked).toBe(true);
        expect(container.querySelector<HTMLInputElement>('[data-initial-id=note]')!.checked).toBe(false);
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
        container.querySelector<HTMLInputElement>('[data-initial-id=note]')!.click();
        container.querySelector<HTMLButtonElement>('[data-initial-restore]')!.click();
        await vi.waitFor(() => expect(container.querySelector('[role=status]')!.textContent).toContain(t('initialFiles.failed')));
        expect(container.querySelector('script')).toBeNull();
        section.destroy(); expect(container.onclick).toBeNull(); expect(container.onchange).toBeNull();
    } finally { section.destroy(); container.remove(); }
});

it('shows preserved resources separately from missing tools and retries dependencies without restoring the Flow again', async () => {
    const dependencies = {flowId: 'example', status: 'missingTools' as const, tools: [{id: 'document.inspect', version: '2', status: 'missing' as const, reason: 'Package is not installed'}], parameters: [], connections: [], errors: []};
    const restore = vi.fn(async () => [{id: 'flow:example', status: 'preserved' as const, dependencies}]);
    const prepareDependencies = vi.fn(async () => [{...dependencies, status: 'ready' as const, tools: [{id: 'document.inspect', status: 'ready' as const}]}]);
    const section = new InitialFilesSection({list: async () => [{id: 'flow:example', group: 'flows', name: 'Example', path: '/example.flow', exists: true}], restore, prepareDependencies});
    const container = document.createElement('div'); document.body.append(container);
    try {
        await section.mount(container); container.querySelector<HTMLInputElement>('[data-initial-id]')!.click();
        expect(await section.restore()).toBe(false);
        const result = () => container.querySelector<HTMLElement>('[data-initial-result]')!;
        expect(result().textContent).toContain(t('initialFiles.preserved')); expect(result().textContent).toContain('document.inspect@2');
        expect(result().textContent).toContain('Package is not installed'); expect(result().textContent).toContain('缺少工具');
        result().querySelector<HTMLButtonElement>('[data-initial-dependencies]')!.click();
        await vi.waitFor(() => expect(result().querySelector('[data-dependencies-status="ready"]')).not.toBeNull());
        expect(result().textContent).toContain(t('initialFiles.preserved')); expect(restore).toHaveBeenCalledOnce();
        expect(prepareDependencies).toHaveBeenCalledWith(['flow:example']); expect(result().querySelector('[data-initial-dependencies]')).toBeNull();
    } finally {section.destroy(); container.remove();}
});

it('keeps required configuration and retry failures actionable without reporting the dependencies as ready', async () => {
    const dependencies = {flowId: 'example', status: 'needsConfiguration' as const, tools: [], parameters: [{code: 'VALUE_REQUIRED', field: 'document', message: '<script>Provide content</script>'}], connections: [{code: 'CONNECTION_REQUIRED', field: 'vision', message: 'Choose an image-capable connection'}], errors: []};
    const prepareDependencies = vi.fn(async () => {throw new Error('Dependency registry is unavailable');});
    const manage = vi.fn(), section = new InitialFilesSection({list: async () => [{id: 'flow:example', group: 'flows', name: 'Example', path: '/example.flow', exists: true}],
        restore: async () => [{id: 'flow:example', status: 'preserved', dependencies}], prepareDependencies}, undefined, {manageDependencies: manage});
    const container = document.createElement('div'); document.body.append(container);
    try {
        await section.mount(container); container.querySelector<HTMLInputElement>('[data-initial-id]')!.click(); await section.restore();
        expect(container.textContent).toContain('需要配置'); expect(container.textContent).toContain('Choose an image-capable connection');
        expect(container.querySelector('script')).toBeNull(); container.querySelector<HTMLButtonElement>('[data-initial-manage-dependencies]')!.click(); expect(manage).toHaveBeenCalledOnce();
        container.querySelector<HTMLButtonElement>('[data-initial-dependencies]')!.click();
        await vi.waitFor(() => expect(container.querySelector('[role="alert"]')!.textContent).toContain('Dependency registry is unavailable'));
        expect(container.querySelector('[data-dependencies-status="needsConfiguration"]')).not.toBeNull();
        expect(container.querySelector<HTMLButtonElement>('[data-initial-dependencies]')!.disabled).toBe(false);
    } finally {section.destroy(); container.remove();}
});
