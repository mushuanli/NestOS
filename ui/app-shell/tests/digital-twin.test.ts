// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DigitalTwinService } from '@itookit/app-core';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { sha256HexSync } from '@itookit/llm-context';
import { TwinWorkbench } from '../src/digital-twin';
import { twinNavigationSource } from '../src/digital-twin/navigation';
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
        form.querySelector<HTMLTextAreaElement>('[name="exclude"]')!.value = '!invalid';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(editor.querySelector('[role=alert]')!.textContent).toContain('TWIN_INVALID_SCAN_RULE'));
        editor.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
        await vi.waitFor(() => expect(editor.querySelector('form')).not.toBe(form));
        form = editor.querySelector<HTMLFormElement>('[data-form="scanPlan"]')!;
        expect(form.querySelector<HTMLTextAreaElement>('[name="include"]')!.value).toBe('file:**/*.md');
        expect([...form.querySelectorAll<HTMLInputElement>('[name="kinds"]')].filter(input => input.checked).map(input => input.value)).toEqual(['fact']);
        form.querySelector<HTMLTextAreaElement>('[name="exclude"]')!.value = '';
        form.querySelector<HTMLSelectElement>('[name="trigger"]')!.value = 'manual';
        form.querySelector<HTMLInputElement>('[name="runTokenLimit"]')!.value = '50000';
        form.querySelector<HTMLInputElement>('[name="autoConfirm"]')!.checked = false;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans).toHaveLength(1));
        await workbench.openResource('/sources'); expect(editor.querySelector('img')).toBeNull();
        const first = (await service.snapshot()).scans.plans[0];
        expect(first.data).toMatchObject({trigger: 'manual', runTokenLimit: 50000, autoConfirm: false});
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
        expect((await service.snapshot()).memories[0].data.state).toBe('candidate');
    } finally { await workbench.destroy(); await service.dispose(); await manager.dispose(); }
});
it('renders scanner and run navigation and allows review, correction and forgetting with honest copy status', async () => {
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
        await workbench.start(); expect(await twinNavigationSource().children(null)).toHaveLength(6);
        expect(editor.querySelector('[data-form=grant]')).toBeNull();
        expect(editor.textContent).toContain(t('twin.defaultKnowledgeUse'));
        const sourceId = await service.addSource({ kind: 'file', target: '/home/admin/notes/source.md', label: 'Source' }, 'model');
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

it('navigates a local graph, merges people and refreshes without losing rule drafts', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), reader: { sessions: async () => [], read: vi.fn() },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() });
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [{ id: 'model', name: 'Model' }], selected: vi.fn() });
    try {
        await service.configure({ connectionId: 'model' }, (await service.snapshot()).settings.revision);
        await service.addMemory({ content: 'Alex leads Alpha', subject: 'Alex', subjectId: 'user:a', project: 'Alpha', relation: { predicate: 'leads', target: 'Alpha', targetKind: 'project' } });
        await service.addMemory({ content: 'Alex prefers email', subject: 'Alex', subjectId: 'user:b' });
        await workbench.start(); await workbench.openResource('/profile');
        expect(editor.querySelector('svg')).not.toBeNull(); expect(editor.textContent).toContain('leads');
        const project = (await service.snapshot()).graph.nodes.find(node => node.kind === 'project')!;
        editor.querySelector<SVGAElement>(`svg [data-id="${project.id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('/profile/' + project.id));
        await workbench.openResource('/profile');
        const form = editor.querySelector<HTMLFormElement>('[data-form=mergePeople]')!;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(async () => expect((await service.snapshot()).graph.nodes.filter(node => node.kind === 'person')).toHaveLength(1));
        await workbench.openResource('/sources');
        let draft = editor.querySelector<HTMLFormElement>('[data-form=scanPlan]')!;
        draft.querySelector<HTMLInputElement>('[name=name]')!.value = 'My rule';
        draft.querySelector<HTMLTextAreaElement>('[name=focus]')!.value = 'Project responsibilities';
        draft.querySelector('[name=focus]')!.dispatchEvent(new Event('input', { bubbles: true }));
        draft.querySelector<HTMLTextAreaElement>('[name=exclude]')!.value = '*.log';
        await service.addMemory({ content: 'Background update' });
        expect(editor.querySelector('[data-form=scanPlan]')).toBe(draft);
        draft = editor.querySelector<HTMLFormElement>('[data-form=scanPlan]')!;
        expect(draft.querySelector<HTMLTextAreaElement>('[name=focus]')!.value).toBe('Project responsibilities');
        draft.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans[0]?.data.focus).toBe('Project responsibilities'));
        expect((await service.snapshot()).scans.plans[0].data.rules?.exclude).toEqual(['*.log']);
    } finally { await workbench.destroy(); await service.dispose(); await manager.dispose(); }
});

it('shows content while loading and recovers a stalled first load without accepting its late result', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), reader: { sessions: async () => [], read: vi.fn() },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() });
    const snapshot = await service.snapshot();
    let complete!: (value: typeof snapshot) => void;
    vi.spyOn(service, 'snapshot').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue(snapshot);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [], selected: vi.fn() });
    vi.useFakeTimers();
    try {
        const starting = workbench.start();
        expect(editor.querySelector('h2')!.textContent).toBe(t('twin.overview'));
        expect(editor.querySelector('[role=status]')!.textContent).toBe(t('status.loading'));
        await vi.advanceTimersByTimeAsync(30_000); await starting;
        expect(editor.querySelector('[role=alert]')!.textContent).toBe(t('twin.loadTimeout'));
        editor.querySelector<HTMLButtonElement>('[data-action=refresh]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(editor.querySelector('[role=alert]')!.textContent).toBe('');
        expect(editor.textContent).toContain(t('twin.recentKnowledge'));
        const rendered = editor.innerHTML;
        complete({ ...snapshot, cleanupError: 'TWIN_CLEANUP_FAILED' });
        await vi.advanceTimersByTimeAsync(0);
        expect(editor.innerHTML).toBe(rendered);
    } finally { vi.useRealTimers(); await workbench.destroy(); await service.dispose(); await manager.dispose(); }
});

it('does not restart a stalled load on background notifications or hide its timeout', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), reader: { sessions: async () => [], read: vi.fn() },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() });
    let changed!: () => void;
    vi.spyOn(service, 'onChange').mockImplementation(listener => { changed = listener; return () => {}; });
    const snapshot = vi.spyOn(service, 'snapshot').mockImplementation(progress => { progress?.('sources.reconcile'); return new Promise(() => {}); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new TwinWorkbench({ service, sidebar, editor, connections: async () => [], selected: vi.fn() });
    vi.useFakeTimers();
    try {
        const starting = workbench.start();
        for (let index = 0; index < 3; index++) { await vi.advanceTimersByTimeAsync(10_000); changed(); }
        await starting;
        expect(warning).toHaveBeenCalledWith('[DigitalTwin] Slow overview load', expect.objectContaining({
            pending: [{ stage: 'sources.reconcile', milliseconds: 5_000 }],
        }));
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(editor.querySelector('[role=alert]')!.textContent).toBe(t('twin.loadTimeout'));
        expect(editor.querySelector('[role=status]')!.textContent).toBe('');
        changed(); await vi.advanceTimersByTimeAsync(0);
        expect(snapshot).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); await workbench.destroy(); await service.dispose(); await manager.dispose(); }
});

it('saves a text scanner with independent Flow arguments and preserves its sources when editing', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const service = new DigitalTwinService({fs: await manager.openFileSystem('/'), reader: {sessions: async () => [], read: vi.fn()},
        extractor: {run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn()}, deleteSession: vi.fn()});
    const target = {kind: 'flow' as const, id: 'reader', version: '1', digest: 'digest'};
    service.setScannerExecution({catalog: async () => ({entries: [{target, name: 'Reader', input: {flowId: 'reader', revision: 1, digest: 'digest',
        parameters: [{name: 'body', type: 'string', inputSource: 'composer.text'}, {name: 'name', type: 'string', required: true}]}}], issues: []}),
        validate: async () => {}, run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn()});
    await service.configure({connectionId: 'model'}, (await service.getSettings()).revision);
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const view = new TwinWorkbench({service, sidebar, editor, connections: async () => [{id: 'model', name: 'Model'}], selected() {}});
    try {
        await view.start(); await view.openResource('/sources');
        const form = editor.querySelector<HTMLFormElement>('[data-form=scanPlan]')!;
        const executor = form.querySelector<HTMLSelectElement>('[name=executor]')!; executor.selectedIndex = 1;
        executor.dispatchEvent(new Event('change', {bubbles: true}));
        const mode = form.querySelector<HTMLSelectElement>('[name=inputMode]')!; mode.value = 'text'; mode.dispatchEvent(new Event('change', {bubbles: true}));
        form.querySelector<HTMLInputElement>('[name=name]')!.value = 'My scanner';
        form.querySelector<HTMLInputElement>('[data-parameter]')!.value = 'argument name';
        form.querySelector<HTMLTextAreaElement>('[name=inputText]')!.value = 'Source snapshot';
        expect(form.querySelector<HTMLElement>('[data-scanner-builtin]')!.hidden).toBe(true);
        form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans).toHaveLength(1));
        const saved = (await service.snapshot()).scans.plans[0];
        expect(saved.data).toMatchObject({name: 'My scanner', executor: {target, values: {name: 'argument name'}}, autoConfirm: false});
        await vi.waitFor(() => expect(editor.querySelector<HTMLFormElement>(`[data-form=scanPlan][data-id="${saved.id}"]`)).not.toBeNull());
        const edit = editor.querySelector<HTMLFormElement>(`[data-form=scanPlan][data-id="${saved.id}"]`)!;
        expect(edit.querySelector<HTMLSelectElement>('[name=inputMode]')!.value).toBe('existing');
        edit.querySelector<HTMLInputElement>('[name=name]')!.value = 'Renamed scanner';
        edit.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
        await vi.waitFor(async () => expect((await service.snapshot()).scans.plans[0].data.name).toBe('Renamed scanner'));
        const updated = (await service.snapshot()).scans.plans[0];
        expect(updated.data.sourceIds).toEqual(saved.data.sourceIds); expect(updated.data.executor).toEqual(saved.data.executor);
    } finally {await view.destroy(); await service.dispose(); await manager.dispose();}
});
