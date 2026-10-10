// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DigitalTwinService } from '@itookit/app-core';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { sha256HexSync } from '@itookit/llm-context';
import { TwinWorkbench } from '../src/digital-twin';
import { t } from '@itookit/common';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
it('retries failed first initialization from the empty page and clears the error on success', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/'), create = fs.driver.createFile.bind(fs.driver);
    vi.spyOn(fs.driver, 'createFile').mockRejectedValueOnce(new Error('Temporary storage failure')).mockImplementation(create);
    const service = new DigitalTwinService({ fs, reader: { sessions: async () => [], read: vi.fn() },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() });
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [], selected: vi.fn() });
    try {
        await workbench.start();
        expect(editor.querySelector('[role=alert]')!.textContent).toBe(t('twin.loadError'));
        expect(diagnostic).toHaveBeenCalledWith('[DigitalTwin] Failed to load overview data', expect.objectContaining({ message: 'Temporary storage failure' }));
        editor.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
        await vi.waitFor(() => expect(editor.querySelector('[role=alert]')!.textContent).toBe(''));
        expect(editor.querySelector('[data-action="refresh"]')).toBeNull();
        expect((await service.snapshot()).settings.data.tokenLimit).toBe(100000);
    } finally { await workbench.destroy(); await service.dispose(); await manager.dispose(); }
});
it('edits automatic rules, previews matches, preserves drafts and shows kernel references', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const resource = { kind: 'file' as const, target: 'alpha.md', projectId: 'Alpha', path: 'alpha.md', label: 'Alpha' };
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'),
        reader: { sessions: async () => [], discover: async () => ({ projects: ['Alpha'], resources: [resource], completeScopes: ['Alpha/file'], errors: [] }),
            read: async () => ({ text: 'Alpha context', hash: sha256HexSync('Alpha context'), nativeIdentity: 'source' }) },
        extractor: { run: async (_job, _text, attached) => { await attached('kernel-task'); return { candidates: [{ content: 'Alpha context', kind: 'fact', subject: 'self', project: 'Alpha', eventTime: '', quote: 'Alpha' }], tokens: 20 }; },
            cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {} });
    await service.configure({ connectionId: 'model' }, (await service.snapshot()).settings.revision);
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [{ id: 'model', name: 'Model' }], selected: vi.fn() });
    try {
        await workbench.start(); await workbench.openResource('/sources');
        let form = editor.querySelector<HTMLFormElement>('[data-form="scanPlan"]')!;
        expect(form.querySelector('[name="sourceIds"]')).toBeNull(); expect(form.querySelector('[name="connectionId"]')).toBeNull();
        form.querySelector<HTMLInputElement>('[name="name"]')!.value = '<img src=x onerror=alert(1)>';
        form.querySelector<HTMLTextAreaElement>('[name="include"]')!.value = 'file:**/*.md';
        form.querySelectorAll<HTMLInputElement>('[name="kinds"]').forEach(input => { input.checked = input.value === 'fact'; });
        form.querySelector<HTMLButtonElement>('[data-action="previewRule"]')!.click();
        await vi.waitFor(() => expect(form.querySelector('[data-preview]')!.textContent).toContain('alpha.md'));
        expect((await service.snapshot()).sources).toHaveLength(0);
        await workbench.openResource('/overview'); await workbench.openResource('/sources');
        form = editor.querySelector<HTMLFormElement>('[data-form="scanPlan"]')!;
        form.querySelector<HTMLInputElement>('[name="name"]')!.value = '<img src=x onerror=alert(1)>';
        form.querySelector<HTMLTextAreaElement>('[name="include"]')!.value = 'file:**/*.md';
        form.querySelectorAll<HTMLInputElement>('[name="kinds"]').forEach(input => { input.checked = input.value === 'fact'; });
        form.querySelector<HTMLTextAreaElement>('[name="exclude"]')!.value = 'invalid';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(editor.querySelector('[role=alert]')!.textContent).toContain('TWIN_INVALID_SCAN_RULE'));
        editor.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
        await vi.waitFor(() => expect(editor.querySelector('form')).not.toBe(form));
        form = editor.querySelector<HTMLFormElement>('[data-form="scanPlan"]')!;
        expect(form.querySelector<HTMLTextAreaElement>('[name="include"]')!.value).toBe('file:**/*.md');
        expect([...form.querySelectorAll<HTMLInputElement>('[name="kinds"]')].filter(input => input.checked).map(input => input.value)).toEqual(['fact']);
        form.querySelector<HTMLTextAreaElement>('[name="exclude"]')!.value = '';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans).toHaveLength(1));
        await workbench.openResource('/sources'); expect(editor.querySelector('img')).toBeNull();
        const first = (await service.snapshot()).scans.plans[0];
        await service.saveScanRule(null, null, { name: 'Second rule', include: ['project:Alpha'], exclude: [], intervalMinutes: 30, enabled: true });
        await workbench.openResource('/sources/plans');
        editor.querySelector<HTMLButtonElement>(`[data-action="runScanPlan"][data-id="${first.id}"]`)!.click();
        await vi.waitFor(async () => expect((await service.snapshot()).scans.runs[0]?.data.state).toBe('succeeded'));
        await workbench.openResource('/sources/runs'); expect(editor.textContent).toContain('kernel-task');
        await workbench.openResource('/sources/sources'); expect(editor.querySelector('[data-form="source"]')).toBeNull();
        await workbench.openResource('/sources/plans');
        editor.querySelector<HTMLButtonElement>(`[data-action="pauseScanPlan"][data-id="${first.id}"]`)!.click();
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans.find(plan => plan.id === first.id)!.data.enabled).toBe(false));
        vi.spyOn(window, 'confirm').mockReturnValue(true); await workbench.openResource('/sources/plans');
        editor.querySelector<HTMLButtonElement>(`[data-action="removeScanPlan"][data-id="${first.id}"]`)!.click();
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans).toHaveLength(1));
        expect((await service.snapshot()).memories[0].data.state).toBe('active');
    } finally { await workbench.destroy(); await service.dispose(); await manager.dispose(); }
});
it('renders five pages and allows review, correction and forgetting with honest copy status', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'),
        reader: { sessions: async () => [{ id: 'session', title: 'Consumer' }], read: async () => ({ text: '<script>Alpha TypeScript</script>', hash: sha256HexSync('source'), nativeIdentity: 'source' }) },
        extractor: { run: async (_job, _text, attached) => { await attached('task'); return { candidates: [{ content: '<script>Alpha TypeScript</script>', kind: 'fact', subject: 'self', project: 'Alpha', eventTime: '', quote: 'Alpha' }], tokens: 10 }; },
            cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {} });
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [{ id: 'model', name: 'Model' }], selected: vi.fn() });
    const idle = () => vi.waitFor(() => expect(editor.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false));
    const submit = async (form: HTMLFormElement) => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await idle(); };
    const click = async (action: string) => { editor.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click(); await idle(); };
    try {
        await workbench.start(); expect(sidebar.querySelectorAll('[data-page]')).toHaveLength(5);
        const sourceId = await service.addSource({ kind: 'file', target: '/home/admin/minds/source.md', label: 'Source' }, 'model');
        await service.analyze(sourceId);
        await vi.waitFor(async () => expect((await service.snapshot()).memories).toHaveLength(1));
        await workbench.openResource('/memories'); expect(editor.querySelector('script')).toBeNull();
        await click('confirm'); expect((await service.snapshot()).memories[0].data.state).toBe('active');
        const correction = editor.querySelector<HTMLFormElement>('[data-form="correct"]')!;
        correction.querySelector<HTMLTextAreaElement>('[name="content"]')!.value = 'Alpha uses Rust';
        await submit(correction);
        expect((await service.snapshot()).memories[0].data).toMatchObject({ content: 'Alpha uses Rust', independent: true });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await click('forget'); expect((await service.snapshot()).memories).toHaveLength(0);
        expect(editor.textContent).toContain(t('twin.forgotten'));
        await workbench.openResource('/profile'); expect(editor.textContent).toContain(t('twin.people'));
        await workbench.openResource('/goals'); expect(editor.textContent).toContain(t('twin.goalHelp'));
        await workbench.destroy();
        expect((service as any).listeners.size).toBe(0);
    } finally { await workbench.destroy(); await manager.dispose(); }
});
