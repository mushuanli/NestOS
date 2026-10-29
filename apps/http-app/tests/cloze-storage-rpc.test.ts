import { expect, it, vi } from 'vitest';
import { createApplicationRuntime } from '@itookit/app-core';
import { openApplicationView } from '@itookit/app-core/host';
import { CLOZE_SRS_PATH, clozeDocumentPrefix } from '@itookit/app-contracts';
import { MemoryBackend } from '@itookit/vfs-core';
import { RpcPeer, installViewProjections } from '@itookit/app-transport/application';

it('writes shared notes state through real RPC and tracks unopened file rename and deletion', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web',
        startupMode: 'interactive', digitalTwinAutoStart: false });
    const view = await openApplicationView(runtime), report = vi.fn();
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), report, installViewProjections);
    server = new RpcPeer('server', async call => { client.applyUpdates(await server.refresh()); return client.handle(call); }, report);
    try {
        const boot = await server.bootstrap(view.services.vfs); client.applyUpdates(boot.updates);
        const remote = client.decode(boot.value!), fs = await remote.openFileSystem('/home/admin/notes');
        await fs.driver.createFile({ parentPath: '/', name: 'a.md', content: '--alpha--' });
        expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
        await fs.driver.createFile({ parentPath: '/.nestos', name: 'cloze-srs.seq', type: 'seqfile', recursive: true });
        const oldKey = clozeDocumentPrefix('/a.md') + 'card:x', newKey = clozeDocumentPrefix('/b.md') + 'card:x';
        await fs.meta.seq.setEntry(CLOZE_SRS_PATH, oldKey, 'progress');
        expect(await fs.meta.seq.getEntry(CLOZE_SRS_PATH, oldKey)).toBe('progress');
        const entries: string[] = [];
        await fs.meta.seq.walkEntries(CLOZE_SRS_PATH, (entry: { key: string }) => { entries.push(entry.key); return true; },
            { keyPrefix: clozeDocumentPrefix('/a.md') });
        expect(entries).toEqual([oldKey]);
        await fs.driver.rename('/a.md', 'b.md');
        await vi.waitFor(async () => expect(await fs.meta.seq.getEntry(CLOZE_SRS_PATH, newKey)).toBe('progress'));
        await fs.meta.seq.setEntry(CLOZE_SRS_PATH, newKey, 'updated');
        await fs.driver.delete(['/b.md']);
        await vi.waitFor(async () => expect(await fs.meta.seq.getEntry(CLOZE_SRS_PATH, newKey)).toBeNull());
        await fs.meta.seq.setEntry(CLOZE_SRS_PATH, 'temporary', '1');
        await fs.meta.seq.deleteEntry(CLOZE_SRS_PATH, 'temporary');
        expect(await fs.meta.seq.getEntry(CLOZE_SRS_PATH, 'temporary')).toBeNull();
        expect(report).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); await view.close(); await runtime.dispose(); }
}, 15000);
