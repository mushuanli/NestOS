/**
 * @file tauri-bootstrap.test.ts
 *
 * Simulates apps/tauri-app/src/main.ts bootstrap (VFS + service layer)
 * in Node.js with real SQLite sidecars — no Tauri runtime or browser APIs.
 *
 * Mirrors the production backend layout exactly:
 *   rootBackend         ~/.mindos/           SQLite: ~/.mindos/_meta/
 *   module/<name>       ~/.mindos/home/admin/     SQLite: ~/.mindos/_db/<name>/
 *   homeBackend         <homeDir>/            SQLite: ~/.mindos/meta/<path>/
 *
 * If a test fails here it is a VFS/engine bug.
 * If it passes here but fails in Tauri it is a Tauri scope / IFsOps bug.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { Kernel } from '@itookit/durable-kernel';
import { SessionRepository, VFSAgentService, SessionDirectoryStorageResolver, sessionDirectoryStorage } from '@itookit/llm-session';
import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm/core';
import { createMindosLlmPresets, firstChatModelConnection } from '@itookit/kernel-adapters/llm/presets';
import type { IVFSManager } from '@itookit/vfs-core';

// ── Module list (mirrors tauri-app/src/config/modules.ts, minus settings/home) ─

const MODULE_CONFIGS = [
    { name: 'chats',    syncEnabled: true,  isSystem: false },
    { name: 'agents',  syncEnabled: true,  isSystem: true  },
    { name: 'anki',            syncEnabled: true,  isSystem: false },
    { name: 'prompts',         syncEnabled: true,  isSystem: false },
    { name: 'projects',        syncEnabled: true,  isSystem: false },
    { name: 'emails',          syncEnabled: true,  isSystem: false },
    { name: 'private',         syncEnabled: false, isSystem: false },
] as const;

const MODULE_NAMES = MODULE_CONFIGS.map(m => m.name);

// ── Shared fixture (created once for the suite) ───────────────────────────────

interface BootstrapFixture {
    mindosDir: string;
    homeDir:   string;
    tempBase:  string;
    vfs:       IVFSManager;
    llmDriver: LLMDeviceDriver;
    agentService:  VFSAgentService;
    sessionEngine: SessionRepository;
    dispose(): Promise<void>;
}

let fix: BootstrapFixture;

/** pathToMetaDir — same function as in tauri-app/src/main.ts */
function pathToMetaDir(mindosDir: string, absPath: string): string {
    const name = absPath.replace(/^\/+/, '').replace(/\//g, '_');
    return `${mindosDir}/meta/${name}`;
}

beforeAll(async () => {
    // ── 1. Create temp dir layout (mirrors Rust setup hook) ────────────────────
    const tempBase  = join(tmpdir(), `tauri-sim-${Date.now()}`);
    const mindosDir = join(tempBase, '.mindos');
    const homeDir   = join(tempBase, 'home');

    for (const dir of [
        mindosDir,
        `${mindosDir}/_meta`,
        `${mindosDir}/_db`,
        `${mindosDir}/meta`,
        `${mindosDir}/home/admin`,
        homeDir,
    ]) {
        await fsp.mkdir(dir, { recursive: true });
    }
    for (const name of MODULE_NAMES) {
        await fsp.mkdir(`${mindosDir}/home/admin/${name}`, { recursive: true });
        await fsp.mkdir(`${mindosDir}/_db/${name}`,    { recursive: true });
    }

    // ── 2. Open all backends in parallel (same as main.ts) ────────────────────
    const open = (rootDir: string, sidecarDir: string) =>
        openLocalFSBackend({
            rootDir,
            sidecarDir,
        });

    const [rootBackend, homeBackend, ...moduleBackends] = await Promise.all([
        open(mindosDir, `${mindosDir}/_meta`),
        open(homeDir,   pathToMetaDir(mindosDir, homeDir)),
        ...MODULE_NAMES.map(name =>
            open(`${mindosDir}/home/admin/${name}`, `${mindosDir}/_db/${name}`)
        ),
    ]);

    // ── 3. Create VFS (same as initApp → createVFS) ────────────────────────────
    const { manager: vfs } = await createVFS({
        rootBackend,
        additionalMounts: [
            ...MODULE_NAMES.map((name, i) => ({ path: `/home/admin/${name}`, backend: moduleBackends[i] })),
            { path: '/home/admin/home', backend: homeBackend },
        ],
    });

    // ── 4. LLM device driver (same as bootstrap) ───────────────────────────────
    const llmDriver = new LLMDeviceDriver(vfs, { presets: createMindosLlmPresets(), providerConnectionPolicy: firstChatModelConnection });
    await llmDriver.init();
    vfs.devices.register(llmDriver);
    await llmDriver.createDeviceNodes();
    vfs.devices.freeze();

    // ── 5. Core services ───────────────────────────────────────────────────────
    const agentService   = new VFSAgentService(await vfs.openFileSystem('/home/admin/agents'), llmDriver);
    const sessionEngine  = new SessionRepository(await vfs.openFileSystem('/'));
    await agentService.init();
    await sessionEngine.init();

    fix = {
        mindosDir, homeDir, tempBase, vfs,
        llmDriver, agentService, sessionEngine,
        async dispose() {
            await vfs.dispose?.();
            await fsp.rm(tempBase, { recursive: true, force: true });
        },
    };
}, 30_000);

afterAll(async () => { await fix?.dispose(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tauri-app bootstrap simulation', () => {

    it('VFS mounts: each module directory is accessible', async () => {
        for (const name of MODULE_NAMES) {
            const modulePath = `${fix.mindosDir}/home/admin/${name}`;
            const stat = await fsp.stat(modulePath);
            expect(stat.isDirectory()).toBe(true);
        }
    });

    it('LLMDeviceDriver: default connections exist after init', async () => {
        const connections = await fix.llmDriver.getConnections();
        console.log('[bootstrap] connections:', connections.map(c => c.name));
        // ensureDefaults() should have created at least one connection
        expect(connections.length).toBeGreaterThan(0);
    });

    it('VFSAgentService: default agents exist after init', async () => {
        const agents = await fix.agentService.getAgents();
        console.log('[bootstrap] agents:', agents.map(a => a.name));
        expect(agents.length).toBeGreaterThan(0);
    });

    it('Session creation persists the Session record in the data store', async () => {
        const id = await fix.sessionEngine.createSession('Hello');
        expect((await fix.sessionEngine.getManifest(id)).id).toBe(id);
        expect((await fsp.stat(`${fix.mindosDir}/var/lib/sessions/${id}/session.seq`)).isFile()).toBe(true);
    });

    it('SessionRepository: multiple concurrent createSession calls succeed', async () => {
        const results = await Promise.all([
            fix.sessionEngine.createSession('Concurrent A'),
            fix.sessionEngine.createSession('Concurrent B'),
            fix.sessionEngine.createSession('Concurrent C'),
        ]);

        expect(results.every(id => !!id)).toBe(true);
        expect(new Set(results).size).toBe(3);   // all unique IDs

        expect((await fix.sessionEngine.list()).map(session => session.id)).toEqual(expect.arrayContaining(results));
    });

    it('etc rootfs: LLM connection config is persisted on disk', async () => {
        // /etc is a rootfs built-in directory (v4.1), not a mounted module → ~/.mindos/etc/
        const etcPath = `${fix.mindosDir}/etc`;
        const stat = await fsp.stat(etcPath).catch(() => null);
        expect(stat?.isDirectory()).toBe(true);

        // LLM connection files should be under etc/llm/.connections/
        const connDir = `${etcPath}/llm/.connections`;
        const connStat = await fsp.stat(connDir).catch(() => null);
        console.log('[bootstrap] .connections dir exists:', !!connStat);
        expect(connStat).toBeTruthy();

        const connFiles = await fsp.readdir(connDir);
        console.log('[bootstrap] connection files:', connFiles);
        expect(connFiles.length).toBeGreaterThan(0);
    });

    it('restores every runnable Task from the chat module and retains explicit pause', async () => {
        const chatId = await fix.sessionEngine.createSession('Durable recovery');
        const fs = await fix.vfs.openFileSystem('/');
        const makeKernel = (maxConcurrent: number) => {
            const kernel = new Kernel({ catalog: { fs }, maxConcurrent });
            kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
            kernel.registerProgram({
                manifest: { kind: 'bootstrap-recovery', version: '1' },
                init(input) { return { state: null, next: { type: 'complete', output: input } }; },
                reduce() { throw new Error('unexpected'); },
            });
            return kernel;
        };
        const first = makeKernel(0), replacement = makeKernel(2);
        try {
            await first.initialize();
            const session = await first.createSession({ id: chatId, storage: sessionDirectoryStorage(chatId) });
            const tasks = await Promise.all(['a', 'b', 'paused'].map(input => session.spawn({
                program: { kind: 'bootstrap-recovery', version: '1' }, input,
            })));
            await tasks[2].pause({ requestId: 'pause' });
            first.dispose(); await first.waitIdle();
            await replacement.initialize();
            expect((await replacement.recoverSession(chatId, { takeover: true })).rebuiltIndexes).toBe(3);
            const restored = await replacement.openSession(chatId);
            for (let i = 0; i < 2; i++) {
                expect((await (await restored.attachTask(tasks[i].id)).wait({ timeoutMs: 2000 })).output).toBe(['a', 'b'][i]);
            }
            const paused = await restored.attachTask(tasks[2].id);
            expect((await paused.status()).task.control?.mode).toBe('pause');
            await paused.resume({ requestId: 'resume' });
            expect((await paused.wait({ timeoutMs: 2000 })).output).toBe('paused');
        } finally {
            first.dispose(); replacement.dispose();
            await Promise.all([first.waitIdle(), replacement.waitIdle()]);
        }
    });

    it('home module: can write and read a file', async () => {
        const homeDir = `${fix.mindosDir}/home/admin/home`;  // mounted on homeDir temp path
        // Write through VFS
        const content = new TextEncoder().encode('hello from home');
        await (await fix.vfs.openFileSystem('/home/admin/home')).driver.createFile({ name: 'test.md', parentPath: '/', content });

        // Verify on real disk (homeDir is the temp home path)
        const onDisk = await fsp.readFile(join(fix.homeDir, 'test.md'));
        expect(new TextDecoder().decode(onDisk)).toBe('hello from home');
    });
});

it('reads nested workspace content through the admin home view', async () => {
    const chats = await fix.vfs.openFileSystem('/home/admin/chats');
    await chats.driver.createFile({ name: 'nested-read.txt', parentPath: '/', content: 'visible' });
    await chats.driver.createFile({ name: 'nested-events.seq', parentPath: '/', type: 'seqfile' });
    await chats.meta.seq!.setEntry('/nested-events.seq', 'event', 'visible-record');
    const home = await fix.vfs.openFileSystem('/home/admin');
    expect(await home.driver.readContent('/chats/nested-read.txt', { encoding: 'utf-8' })).toBe('visible');
    await chats.driver.writeContent('/nested-read.txt', 'updated');
    expect(await home.driver.readContent('/chats/nested-read.txt', { encoding: 'utf-8' })).toBe('updated');
    expect(await home.driver.readContent('/chats/nested-events.seq', { encoding: 'utf-8' })).toBe('event=visible-record');
});
