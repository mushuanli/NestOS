// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {DigitalTwinService} from '@itookit/app-core';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {scanRunPage, scanRunState} from '../src/digital-twin/scan-view';
it('shows a saved batch awaiting continuation, without false zero-source counts or model budget controls', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const twin = new DigitalTwinService({fs: await manager.openFileSystem('/'), reader: {read: async () => {throw new Error('Unused');}, sessions: async () => []},
        extractor: {run: async () => {throw new Error('Unused');}, cancel: async () => {}, cleanup: async () => {}}, deleteSession: async () => {}});
    try {
        twin.setCollector({collect: async () => ({version: 1, complete: false, processed: 100}), validate: () => {}, cancelCollection: async () => {}});
        const plan = await twin.saveScanRule(null, null, {name: 'Batch', mode: 'collect', trigger: 'manual', intervalMinutes: 30, enabled: true, include: [], exclude: [],
            collection: {target: {kind: 'tool', id: 'fixture', version: '1', digest: 'fixed'}}});
        await twin.waitScanRun(await twin.runScanPlan(plan));
        const snapshot = await twin.snapshot(), root = document.createElement('div'); root.innerHTML = scanRunPage(snapshot);
        expect(scanRunState(snapshot.scans.runs[0].data)).toBe('本批已保存，等待继续采集');
        expect(root.textContent).toContain('100'); expect(root.textContent).not.toContain('0 / 0');
        expect(root.textContent).not.toContain('累计 token 预算');
        expect(root.querySelector('[data-action="runScanPlan"]')).not.toBeNull();
    } finally {await twin.dispose(); await manager.dispose();}
});
