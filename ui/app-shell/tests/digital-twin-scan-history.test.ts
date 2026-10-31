// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {DigitalTwinService} from '@itookit/app-core';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {TwinWorkbench} from '../src/digital-twin';
import {scannerHistory} from '../src/digital-twin/scan-history';
import type {TwinSnapshot} from '../src/digital-twin/view';

type Run = TwinSnapshot['scans']['runs'][number];
function run(id: string, createdAt: number, patch: Partial<Run['data']> = {}): Run {
    return {id, revision: '1', data: {planId: 'scanner', name: 'Collector', createdAt, startedAt: createdAt + 100,
        finishedAt: createdAt + 2100, state: 'succeeded', mode: 'collect', error: '',
        ...patch} as Run['data']};
}
function render(rows: Run[], plan = 'scanner') {
    const root = document.createElement('div'); root.innerHTML = scannerHistory(plan, rows); return root;
}
it('shows only the scanner’s latest five runs in descending order and links each to its own details', () => {
    const rows = Array.from({length: 7}, (_, i) => run('run-' + i, 10000 + i * 3000));
    rows.push(run('another-scanner', 999999, {planId: 'other'}));
    const root = render(rows.reverse());
    expect([...root.querySelectorAll('[data-scanner-run]')].map(item => item.getAttribute('data-scanner-run')))
        .toEqual(['run-6', 'run-5', 'run-4', 'run-3', 'run-2']);
    expect(root.querySelector('[data-scanner-latest]')!.textContent).toContain('耗时 2000 ms');
    expect(root.querySelector('[data-action="openScanRun"]')!.getAttribute('data-id')).toBe('run-6');
    expect(root.textContent).not.toContain('another-scanner'); expect(rows).toHaveLength(8);
});
it('shows zero counts, pending batches, escaped errors and the saved destination directly in the scanner', () => {
    const root = render([run('zero', 20000, {collectionProgress: {version: 1, complete: false, processed: 20, batchCount: 0},
        collection: {target: {kind: 'tool', id: 'fixture', version: '1', digest: 'fixed'}, destination: 'emails'}}),
        run('failure', 10000, {state: 'failed', error: 'TWIN_COLLECTION_FAILED', errorDetail: 'GOOGLE_MAIL_BODY_UNAVAILABLE <img src=x onerror=alert(1)>'})]);
    expect(root.querySelector('[data-scanner-latest]')!.textContent).toContain('本批归档 0 项');
    expect(root.textContent).toContain('本轮累计处理 20 条'); expect(root.textContent).toContain('等待继续采集');
    expect(root.textContent).toContain('/home/admin/emails'); expect(root.textContent).toContain('GOOGLE_MAIL_BODY_UNAVAILABLE');
    expect(root.querySelector('img')).toBeNull();
    const failure = render([run('failure', 10000, {state: 'failed', error: 'TWIN_COLLECTION_FAILED', errorDetail: 'GOOGLE_MAIL_BODY_UNAVAILABLE'})]);
    expect(failure.querySelector('[data-scanner-latest]')!.textContent).toContain('GOOGLE_MAIL_BODY_UNAVAILABLE');
});
it('does not invent counts or durations for legacy, queued and running records', () => {
    const root = render([run('queued', 20000, {state: 'queued', startedAt: 0, finishedAt: 0}),
        run('running', 10000, {state: 'running', finishedAt: 0})]);
    expect(root.textContent).toContain('排队中'); expect(root.textContent).toContain('运行中');
    expect(root.textContent).not.toContain('耗时'); expect(root.textContent).not.toContain('本批归档');
    expect(render([]).textContent).toContain('暂无运行记录');
});
it('keeps recent logs expanded after refresh and opens the selected run from the scanner card', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const service = new DigitalTwinService({fs: await manager.openFileSystem('/'), reader: {read: vi.fn(), sessions: async () => []},
        extractor: {run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn()}, deleteSession: vi.fn()});
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const selected = vi.fn(), workbench = new TwinWorkbench({service, sidebar, editor, connections: async () => [], selected});
    try {
        service.setCollector({collect: async () => ({version: 1, complete: true, processed: 0, batchCount: 0}), validate: () => {}, cancelCollection: async () => {}});
        const plan = await service.saveScanRule(null, null, {name: 'Inbox', mode: 'collect', trigger: 'manual', intervalMinutes: 30,
            enabled: true, include: [], exclude: [], collection: {target: {kind: 'tool', id: 'fixture', version: '1', digest: 'fixed'}}});
        const id = await service.runScanPlan(plan); await service.waitScanRun(id);
        await workbench.start(); await workbench.openResource('/sources');
        expect(editor.querySelector('[data-scanner-latest]')!.textContent).toContain('本批归档 0 项');
        const history = editor.querySelector<HTMLDetailsElement>('[data-scanner-history]')!; history.open = true;
        workbench.invalidateFromEvents();
        await vi.waitFor(() => expect(editor.querySelector('[data-scanner-history]')).not.toBe(history));
        expect(editor.querySelector<HTMLDetailsElement>('[data-scanner-history]')!.open).toBe(true);
        editor.querySelector<HTMLButtonElement>('[data-action="openScanRun"]')!.click();
        await vi.waitFor(() => expect(selected).toHaveBeenLastCalledWith('/runs/' + encodeURIComponent(id)));
        await vi.waitFor(() => expect(editor.querySelector('[data-scan-run]')?.getAttribute('data-scan-run')).toBe(id));
        expect(editor.textContent).toContain('本批归档 0 项');
    } finally {await workbench.destroy(); await service.dispose(); await manager.dispose(); document.body.replaceChildren();}
});
