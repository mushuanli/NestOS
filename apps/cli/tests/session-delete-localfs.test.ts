import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { Kernel } from '@itookit/durable-kernel';
import { SessionDirectoryStorageResolver, SessionRepository, sessionDirectoryStorage } from '@itookit/llm-session';
import { SessionLifecycleService } from '@itookit/app-core';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(run => run())); });

/** Real localfs backend: files land under `<root>/data`, metadata in `<root>/meta/index.db`. */
async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-session-delete-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const backend = await openLocalFSBackend({ rootDir: `${root}/data`, sidecarDir: `${root}/meta` });
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    const kernel = new Kernel({ catalog: { fs, rootPath: '/var/lib/kernel' } });
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
    await kernel.initialize();
    // One ordered teardown: let in-flight poll ticks settle before closing storage.
    cleanup.push(async () => {
        kernel.dispose(); await kernel.waitIdle();
        await new Promise(resolve => setTimeout(resolve, 25));
        await repository.dispose(); await manager.dispose();
    });
    return { root, fs, repository, kernel, lifecycle: new SessionLifecycleService({ repository, kernel }) };
}

/** Physical location of a Session directory on the host filesystem. */
function sessionDir(root: string, id: string): string {
    return path.join(root, 'data', 'var/lib/sessions', id);
}

function runWorker(...args: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'tests/session-delete-worker.ts', ...args], { cwd: CLI_ROOT });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(`worker ${args[0]} exited ${code}: ${stderr}`));
            const line = stdout.trim().split('\n').filter(Boolean).pop();
            if (!line) return reject(new Error(`worker ${args[0]} printed nothing: ${stderr}`));
            resolve(JSON.parse(line) as Record<string, unknown>);
        });
    });
}

it('keeps Session data on disk when the pinned Kernel layout blocks the delete', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Guarded');
    await f.repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    expect(existsSync(sessionDir(f.root, id))).toBe(true);

    await expect(f.repository.deleteSession(id)).rejects.toMatchObject({ code: 'EBUSY' });
    // Nothing was cleared: records still readable and the directory still on disk.
    expect((await f.repository.getManifest(id)).id).toBe(id);
    expect(await f.repository.readDocument(id, 'round-r1.json')).toContain('r1');
    expect(existsSync(path.join(sessionDir(f.root, id), 'session.seq'))).toBe(true);
}, 15_000);

it('deletes the Session from the real filesystem through the lifecycle service', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Disposable');
    await f.repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    const session = await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    await session.setShared('topic', 'value');

    await f.lifecycle.deleteSession(id);
    expect(existsSync(sessionDir(f.root, id))).toBe(false);
    await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
    const ids: string[] = []; for await (const record of f.kernel.listSessions()) ids.push(record.id);
    expect(ids).not.toContain(id);
}, 15_000);

it('refuses to remove a Session with a live Task and deletes it after close', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Busy');
    await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    f.kernel.registerProgram({ manifest: { kind: 'test', version: '1' },
        init: () => ({ state: null, actions: [{ type: 'request-interaction', interaction: { id: 'hold', kind: 'input', prompt: 'Hold' } }],
            next: { type: 'wait', on: { type: 'interaction', id: 'hold' } } }),
        reduce: () => ({ state: null, next: { type: 'complete', output: 'done' } }),
    });
    const task = await (await f.kernel.openSession(id)).submit({ program: { kind: 'test', version: '1' }, input: null });
    // The poll claims the Task asynchronously; wait for the persisted status instead of assuming
    // it flipped within the first tick.
    await vi.waitFor(async () => {
        await expect(task.status()).resolves.toMatchObject({ task: { status: 'waiting' } });
    });

    // A live Task keeps the Session: the physical delete must not proceed.
    await expect(f.kernel.removeSession(id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(existsSync(sessionDir(f.root, id))).toBe(true);

    await f.lifecycle.deleteSession(id);
    expect(existsSync(sessionDir(f.root, id))).toBe(false);
    await expect(f.kernel.task(id, task.id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
}, 15_000);

it('recovers an interrupted deletion across a real process restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-session-restart-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const id = 'interrupted-session';

    const prepared = await runWorker('prepare', root, id);
    expect(prepared).toMatchObject({ prepared: true, kernelStorageGone: true });
    // Kernel storage is gone; the repository data is still on the real filesystem.
    expect(existsSync(path.join(sessionDir(root, id), 'kernel'))).toBe(false);
    expect(existsSync(path.join(sessionDir(root, id), 'session.seq'))).toBe(true);

    const finished = await runWorker('finish', root, id);
    expect(finished).toMatchObject({ manifest: 'ENOENT', ids: [], dirGone: true });
    expect(existsSync(sessionDir(root, id))).toBe(false);

    // A third process reusing the identity must not see the removed state.
    expect(await runWorker('reuse', root, id)).toMatchObject({ before: 'closed', after: 'open', stale: null });
}, 30_000);
