/**
 * @file ui/app-shell/tests/helpers-localfs.ts
 *
 * Test helpers for LocalFS-backed VFS integration tests.
 *
 * LocalFSBackend is used as rootBackend — the simplest setup.
 * VFS creates its system directories (dev/, etc/, module/) inside rootDir,
 * and the 'test' module's real files land at rootDir/module/test/.
 *
 * The helper exposes `moduleDir` (= rootDir/module/test/) for disk assertions
 * so tests check the right physical location.
 *
 * Directories are NOT cleaned up after tests — browse them to inspect state:
 *   tests/test_vfsroot/<suite>/<NNN>/module/test/   ← user files here
 *   tests/test_sidecar/<suite>/<NNN>/               ← SQLite + vfs-internal
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { FakeSidecarDb } from './fake-sidecar';
import { createVFS } from '@itookit/vfs-core';
import type { IVFSManager, IFileSystem } from '@itookit/vfs-core';

// ── Paths ──────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

export const TEST_ROOT    = resolve(PROJECT_ROOT, 'tests/test_vfsroot');
export const SIDECAR_ROOT = resolve(PROJECT_ROOT, 'tests/test_sidecar');

// ── Test context ───────────────────────────────────────────────────────────────

export interface LocalTestVFS {
    /** VFS system root — contains dev/, etc/, module/ created by VFSEngine. */
    rootDir:    string;
    /** rootDir/module/test/ — where the 'test' module files actually live on disk. */
    moduleDir:  string;
    /** SQLite + staging + vfs-internal, outside rootDir. */
    sidecarDir: string;
    manager:    IVFSManager;
    fs:         IFileSystem;
    dispose():  Promise<void>;
}

let _seq = 0;

export async function setupLocalVFS(suite: string): Promise<LocalTestVFS> {
    const id         = String(++_seq).padStart(3, '0');
    const rootDir    = join(TEST_ROOT,    suite, id);
    const sidecarDir = join(SIDECAR_ROOT, suite, id);
    const moduleDir  = join(rootDir, 'module', 'test');

    await fsp.rm(rootDir,    { recursive: true, force: true });
    await fsp.rm(sidecarDir, { recursive: true, force: true });
    await fsp.mkdir(rootDir,    { recursive: true });
    await fsp.mkdir(sidecarDir, { recursive: true });

    // LocalFSBackend as rootBackend: dev/, etc/, module/ land inside rootDir.
    // The 'test' module's files are at rootDir/module/test/ (= moduleDir).
    // This is correct — VFS properly scopes each module's view.
    const backend = await openLocalFSBackend({
        rootDir,
        sidecarDir,
        // In-memory sidecar: avoids the better-sqlite3 native module in tests.
        createDb: async () => new FakeSidecarDb(),
    });
    const { manager } = await createVFS({
        rootBackend: backend,
    });

    const fs = await manager.openFileSystem('/module/test');

    return { rootDir, moduleDir, sidecarDir, manager, fs,
             dispose: () => manager.dispose() };
}

// ── Disk inspection helpers ────────────────────────────────────────────────────

export async function diskExists(base: string, rel: string): Promise<boolean> {
    return fsp.access(join(base, rel)).then(() => true).catch(() => false);
}

export async function diskRead(base: string, rel: string): Promise<string> {
    return fsp.readFile(join(base, rel), 'utf-8');
}

export async function diskList(base: string, rel = '.'): Promise<string[]> {
    return fsp.readdir(join(base, rel)).catch(() => []);
}

export async function diskStat(base: string, rel: string) {
    return fsp.stat(join(base, rel)).catch(() => null);
}

export function text(s: string): ArrayBuffer {
    return new TextEncoder().encode(s).buffer as ArrayBuffer;
}
