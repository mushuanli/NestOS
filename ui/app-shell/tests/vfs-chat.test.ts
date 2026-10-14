/**
 * @file VFS + SessionRepository integration test (pure Node.js, no Tauri)
 *
 * Verifies that chat file creation works end-to-end through the real
 * LocalFSBackend stack (NodeFsOps + BetterSqliteSidecarDb), isolating
 * whether bugs are in the VFS/engine layer or Tauri-specific layer.
 *
 * Layout mirrors tauri-app production:
 *   rootBackend  = IndexedDBBackend (fake-indexeddb) → /etc/, /dev/
 *   chats module = LocalFSBackend   (real Node.js fs) → /home/admin/chats/
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVFS } from '@itookit/vfs-core';
import type { IFileSystem } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { FakeSidecarDb } from './fake-sidecar';
import { SessionRepository } from '@itookit/llm-session';

// ── Temp dir helpers ──────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
    const dir = join(tmpdir(), `app-shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

// ── Test fixture ──────────────────────────────────────────────────────────────

interface Fixture {
    chatsDir: string;
    sidecarDir: string;
    tempBase: string;
    engine: SessionRepository;
    /** File tree view — use this for loadTree / getChildren */
    treeEngine: IFileSystem;
    dispose(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
    const tempBase  = await makeTempDir();
    const chatsDir  = join(tempBase, 'chats');
    const sidecarDir = join(tempBase, 'chats-db');
    await fsp.mkdir(chatsDir,   { recursive: true });
    await fsp.mkdir(sidecarDir, { recursive: true });

    // LocalFSBackend for chats (auto-selects NodeFsOps + BetterSqliteSidecarDb)
    const chatsBackend = await openLocalFSBackend({
        rootDir: chatsDir,
        sidecarDir,
        createDb: async () => new FakeSidecarDb(),
    });

    const { manager: vfs } = await createVFS({
        // IndexedDB (fake) for system paths (/etc/, /dev/)
        rootBackend: chatsBackend,
    });

    const engine = new SessionRepository(await vfs.openFileSystem('/'));
    await engine.init();

    // IFileSystem for file-tree operations (loadTree, getChildren)
    const treeEngine = await vfs.openFileSystem('/home/admin/chats');

    return {
        chatsDir,
        sidecarDir,
        tempBase,
        engine,
        treeEngine,
        async dispose() {
            await vfs.dispose?.();
            await fsp.rm(tempBase, { recursive: true, force: true });
        },
    };
}

describe('Session repository on LocalFS', () => {
    let fix: Fixture;
    beforeEach(async () => { fix = await createFixture(); });
    afterEach(async () => { await fix.dispose(); });
    it('persists Session metadata, history and binary attachments', async () => {
        const id = await fix.engine.createSession('Session');
        await fix.engine.writeDocument(id, 'round-one.json', '{"content":"hello"}');
        await fix.engine.writeAttachment(id, 'image.bin', new Uint8Array([0, 255]).buffer);
        expect((await fix.engine.getManifest(id)).title).toBe('Session');
        expect(await fix.engine.readDocument(id, 'round-one.json')).toBe('{"content":"hello"}');
        expect(new Uint8Array(await (await fix.engine.readSessionAsset(id, 'image.bin'))!.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
    });
    it('lists independent Sessions after title changes', async () => {
        const ids = await Promise.all([fix.engine.createSession('A'), fix.engine.createSession('B')]);
        await fix.engine.updateManifest(ids[0], { title: 'Renamed' });
        expect((await fix.engine.list()).map(session => session.id)).toEqual(expect.arrayContaining(ids));
        expect((await fix.engine.getManifest(ids[0])).title).toBe('Renamed');
    });
});
