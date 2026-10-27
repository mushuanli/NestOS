import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { createVFS } from '@itookit/vfs-core';
import { DigitalTwinService, SeqTwinStore } from '@itookit/app-core';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { openLocalApplication } from '../src/application-host';
import { createHash } from 'node:crypto';
import { scanCommand } from '../src/digital-twin-scans-command';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('registers watch shutdown before announcing readiness and removes signal handlers on stop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nestos-twin-watch-')); roots.push(root);
    const host = await openLocalApplication({ profile: root }, false);
    const runtime = host.runtime;
    const before = new Set(process.listeners('SIGTERM'));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
        const stop = process.listeners('SIGTERM').find(listener => !before.has(listener));
        expect(stop).toBeDefined(); stop!('SIGTERM'); return true;
    });
    try {
        await scanCommand(runtime.digitalTwin!, ['watch']);
        expect(new Set(process.listeners('SIGTERM'))).toEqual(before);
    } finally { output.mockRestore(); await host.close(); }
});
it('persists CLI scan plans and queued work through SQLite reopen without registering a workspace', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'nestos-twin-scans-')); roots.push(rootDir);
    const open = async () => {
        const backend = await openLocalFSBackend({ rootDir, sidecarDir: path.join(rootDir, '_meta'), createDb: NodeSqliteSidecarDb.open });
        const { manager } = await createVFS({ rootBackend: backend });
        const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), reader: {
            read: async () => ({ text: 'SQLite scan input', hash: createHash('sha256').update('SQLite scan input').digest('hex'), nativeIdentity: 'file' }), sessions: async () => [] },
            extractor: { run: async (_job, _text, attached) => { await attached('sqlite-task'); return { candidates: [], tokens: 10 }; },
                cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {}, scanHost: { kind: 'cli' } });
        return { manager, service, close: async () => { await service.dispose(); await manager.dispose(); } };
    };
    let host = await open();
    const sourceId = await host.service.addSource({ kind: 'file', target: '/home/admin/minds/sqlite.md', label: 'SQLite' }, 'model');
    const planId = await scanCommand(host.service, ['plan-create'], JSON.stringify({ name: 'SQLite plan', sourceIds: [sourceId], connectionId: 'model' })) as string;
    await host.service.configure({ paused: true }, (await host.service.snapshot()).settings.revision);
    const runId = await host.service.runScanPlan(planId); await host.service.scanOnce(); await host.close();
    host = await open();
    try {
        expect((await host.service.snapshot()).scans.runs[0]).toMatchObject({ id: runId, data: { state: 'queued', planId } });
        await host.service.configure({ paused: false }, (await host.service.snapshot()).settings.revision);
        await scanCommand(host.service, ['scan-tick']);
        expect((await host.service.snapshot()).scans.runs[0].data).toMatchObject({ state: 'succeeded', spentTokens: 10 });
        const plan = (await host.service.snapshot()).scans.plans[0];
        await scanCommand(host.service, ['plan-delete', planId, plan.revision]);
        expect((await host.service.snapshot()).scans.plans).toHaveLength(0);
    } finally { await host.close(); }
});
it('boots profile administration without registering or modifying the current workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nestos-twin-admin-')); roots.push(root);
    const workspace = path.join(root, 'workspace'), identityPath = path.join(workspace, '.nestos', 'info.seq');
    await mkdir(path.dirname(identityPath), { recursive: true });
    await writeFile(identityPath, 'existing workspace identity');
    const host = await openLocalApplication({ profile: path.join(root, 'profile'), setHome: workspace }, false);
    const runtime = host.runtime;
    try {
        expect((await runtime.digitalTwin!.snapshot()).memories).toHaveLength(0);
        expect(await readFile(identityPath, 'utf8')).toBe('existing workspace identity');
    } finally { await host.close(); }
});
it('persists twin review, authority, CAS and forgetting across real SQLite host restarts', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'nestos-twin-')); roots.push(rootDir);
    const open = async () => {
        const backend = await openLocalFSBackend({ rootDir, sidecarDir: path.join(rootDir, '_meta'), createDb: NodeSqliteSidecarDb.open });
        const { manager } = await createVFS({ rootBackend: backend });
        const fs = await manager.openFileSystem('/');
        const service = new DigitalTwinService({ fs, reader: { read: async () => { throw new Error('unused'); }, sessions: async () => [] },
            extractor: { run: async () => { throw new Error('unused'); }, cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {} });
        return { manager, fs, service };
    };
    let host = await open();
    const id = await host.service.addMemory({ content: 'SQLite retained twin context', kind: 'fact' });
    const initial = (await host.service.snapshot()).memories[0];
    const identity = await (await SeqTwinStore.open(host.fs, 'personal', 'admin')).inspect();
    await host.fs.meta.seq!.setEntry('/var/lib/digital-twin/personal/authority.seq', 'twin', JSON.stringify({ ...identity, layoutVersion: 2 }));
    await host.manager.dispose();
    host = await open();
    try {
        expect(await (await SeqTwinStore.open(host.fs, 'personal', 'admin')).inspect()).toEqual(identity);
        expect((await host.service.snapshot()).memories[0]).toMatchObject({ id, revision: initial.revision, data: { content: 'SQLite retained twin context' } });
        await host.service.review(id, initial.revision, 'correct', { content: 'SQLite corrected context' });
        await expect(host.service.review(id, initial.revision, 'confirm')).rejects.toThrow('REVIEW_CONFLICT');
        await host.service.forget(id);
        expect(await (await SeqTwinStore.open(host.fs, 'personal', 'admin')).read({ family: 'memory', id })).toBeNull();
    } finally { await host.manager.dispose(); }
    host = await open();
    try {
        expect((await host.service.snapshot()).memories).toHaveLength(0);
        await expect((await SeqTwinStore.open(host.fs, 'personal', 'admin')).inspect()).resolves.toMatchObject({ forgetEpoch: 1 });
        const rows: string[] = [];
        await host.fs.meta.seq!.walkEntries('/var/lib/digital-twin/personal/knowledge.seq', entry => { rows.push(entry.value); return true; });
        expect(rows.join('')).not.toContain('SQLite retained'); expect(rows.join('')).not.toContain('SQLite corrected');
    } finally { await host.manager.dispose(); }
});
it('persists automatic rule selectors and incrementally reconciles real SQLite-backed document changes', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'nestos-twin-rules-')); roots.push(rootDir);
    const open = async () => {
        const backend = await openLocalFSBackend({ rootDir, sidecarDir: path.join(rootDir, '_meta'), createDb: NodeSqliteSidecarDb.open });
        const { manager } = await createVFS({ rootBackend: backend }), fs = await manager.openFileSystem('/');
        const target = '/home/admin/docs/note.md';
        const service = new DigitalTwinService({ fs, reader: {
            discover: async () => ({ projects: ['alpha'], completeScopes: ['alpha/file'], errors: [], resources: await fs.driver.exists(target)
                ? [{ kind: 'file', target, path: 'docs/note.md', projectId: 'alpha', label: 'Note' }] : [] }),
            read: async () => { const text = await fs.driver.readContent(target, { encoding: 'utf-8' }); return {
                text, hash: createHash('sha256').update(text).digest('hex'), nativeIdentity: 'sqlite-document' }; }, sessions: async () => [] },
            extractor: { run: async (_job, text, attached) => { await attached('sqlite-task'); return {
                candidates: [{ content: text, kind: 'fact', subject: 'self', project: 'alpha', eventTime: '', quote: text }], tokens: 10 }; },
                cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {} });
        return { fs, service, close: async () => { await service.dispose(); await manager.dispose(); } };
    };
    let host = await open();
    await host.fs.driver.createFile({ parentPath: '/home/admin/docs', name: 'note.md', content: 'SQLite original', recursive: true });
    await host.service.configure({ connectionId: 'model' }, (await host.service.snapshot()).settings.revision);
    const rule = await scanCommand(host.service, ['rule-create'], JSON.stringify({ name: 'Automatic', include: ['file:**/*.md'] })) as string;
    await scanCommand(host.service, ['plan-run', rule]); await host.close(); host = await open();
    try {
        expect((await host.service.snapshot()).scans.plans[0].data.rules?.include).toEqual(['file:**/*.md']);
        await host.fs.driver.writeContent('/home/admin/docs/note.md', 'SQLite changed');
        await scanCommand(host.service, ['plan-run', rule]);
        const memories = (await host.service.snapshot()).memories;
        expect(memories.filter(memory => memory.supported).map(memory => memory.data.content)).toEqual(['SQLite changed']);
        await host.fs.driver.delete(['/home/admin/docs/note.md']); await scanCommand(host.service, ['plan-run', rule]);
        expect((await host.service.snapshot()).sources[0].data.status).toBe('deleted');
    } finally { await host.close(); }
});
