// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { DigitalTwinService } from '@itookit/app-core';
import { TwinWorkbench } from '../src/digital-twin';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'),
        reader: { sessions: async () => [], read: async spec => ({ text: 'text', hash: 'hash', nativeIdentity: spec.target }) },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() });
    cleanup.push(() => service.dispose());
    await service.configure({ connectionId: 'model' }, (await service.snapshot()).settings.revision);
    await service.saveScanRule(null, null, { name: 'Rule', include: ['project:Alpha'], exclude: [], intervalMinutes: 30, enabled: true });
    await service.addSource({ kind: 'file', target: 'file.md', label: 'File' }, 'model');
    const snapshot = await service.snapshot(), base = snapshot.scans.plans[0]!, source = snapshot.sources[0]!;
    snapshot.scans.plans = Array.from({ length: 12 }, (_, index) => ({ ...base, id: `plan-${index}`, data: { ...base.data, name: `Rule ${index}`, enabled: index % 2 === 0 } }));
    snapshot.sources = Array.from({ length: 201 }, (_, index) => ({ ...source, id: `source-${index}`, data: { ...source.data,
        label: `Target ${index}`, target: `file-${index}.md`, kind: index === 200 ? 'harness-session' : 'file', status: index === 200 ? 'inaccessible' : 'available' } }));
    vi.spyOn(service, 'snapshot').mockResolvedValue(snapshot);
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const selected = vi.fn();
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [{ id: 'model', name: 'Model' }], selected });
    cleanup.push(() => workbench.destroy()); await workbench.start(); await workbench.openResource('/sources');
    const list = (kind: string) => editor.querySelector<HTMLElement>(`[data-scan-list="${kind}"]`)!;
    const visible = (kind: string) => [...list(kind).querySelectorAll<HTMLElement>('[data-scan-row]')].filter(row => !row.hidden);
    const filter = (kind: string, field: string, value: string) => {
        const control = list(kind).querySelector<HTMLInputElement | HTMLSelectElement>(`[data-scan-filter="${field}"]`)!;
        control.value = value; control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    return { editor, workbench, selected, list, visible, filter };
}

it('paginates rules, combines search and status filters, and restores filters after refresh', async () => {
    const host = await setup();
    expect(host.visible('plans')).toHaveLength(10);
    host.list('plans').querySelector<HTMLButtonElement>('[data-scan-page="next"]')!.click();
    expect(host.visible('plans').map(row => row.dataset.scanRow)).toEqual(['plan-10', 'plan-11']);
    host.filter('plans', 'enabled', 'false'); expect(host.visible('plans')).toHaveLength(6);
    host.filter('plans', 'query', 'Rule 11'); expect(host.visible('plans').map(row => row.dataset.scanRow)).toEqual(['plan-11']);
    await host.workbench.openResource('/sources/plans');
    expect(host.visible('plans').map(row => row.dataset.scanRow)).toEqual(['plan-11']);
    host.filter('plans', 'enabled', 'true'); expect(host.visible('plans')).toHaveLength(0);
    expect(host.list('plans').querySelector<HTMLElement>('[data-scan-no-matches]')!.hidden).toBe(false);
});

it('keeps rule drafts when switching panels and finds targets beyond the old 200-row limit', async () => {
    const host = await setup(), form = host.editor.querySelector<HTMLFormElement>('[data-form="scanPlan"]')!;
    const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
    name.value = 'Draft'; name.dispatchEvent(new Event('input', { bubbles: true }));
    host.editor.querySelector<HTMLButtonElement>('[data-action="scanTab"][data-id="sources"]')!.click();
    await vi.waitFor(() => expect(host.workbench.getActiveResourceId()).toBe('/sources/sources'));
    expect(host.editor.querySelector<HTMLElement>('#twin-scan-panel-plans')!.hidden).toBe(true);
    expect(host.editor.querySelector<HTMLElement>('#twin-scan-panel-sources')!.hidden).toBe(false);
    host.filter('sources', 'kind', 'harness-session'); host.filter('sources', 'state', 'inaccessible');
    expect(host.visible('sources').map(row => row.dataset.scanRow)).toEqual(['source-200']);
    const tab = host.editor.querySelector<HTMLButtonElement>('[data-action="scanTab"][data-id="sources"]')!;
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await vi.waitFor(() => expect(host.workbench.getActiveResourceId()).toBe('/sources/plans'));
    expect(host.editor.querySelector('[data-form="scanPlan"]')).toBe(form); expect(name.value).toBe('Draft');
    expect(host.selected).toHaveBeenLastCalledWith('/sources/plans');
});
