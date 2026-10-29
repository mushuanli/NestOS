import { describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { Kernel } from '@itookit/durable-kernel';
import { DirectoryMountService } from '../src/vfs/directory-mounts';
import { SessionRepository, VFSAgentService } from '@itookit/llm-session';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { createInfrastructure } from '../src/runtime/infrastructure';
import type { ApplicationPlatformServices } from '../src/runtime/create-application-runtime';

describe('application infrastructure', () => {
    it('provides the VFS layout and a frozen LLM device, and closes the injected transport', async () => {
        const close = vi.fn();
        const extra = new MemoryBackend();
        const infrastructure = await createInfrastructure({
            backend: new MemoryBackend(),
            additionalMounts: [{ path: '/extra', backend: extra }],
            codexTransport: { close },
        });
        try {
            expect(infrastructure.vfs.devices.isFrozen()).toBe(true);
            // The scratch mount and host mounts are both reachable from the root view.
            for (const path of ['/run', '/extra', '/home/admin/notes', '/home/admin/projects', '/home/admin/.config']) {
                expect(await infrastructure.systemFS.driver.getNode(path), `Missing infrastructure directory: ${path}`).not.toBeNull();
            }
            expect(infrastructure.llmDriver).toBeDefined();
            // `logIO` reports and resets the public counters.
            infrastructure.logIO('test');
            expect(infrastructure.vfs.ioStats.stat).toBe(0);
            await infrastructure.closeCodexTransport?.();
            expect(close).toHaveBeenCalledOnce();
        } finally {
            await infrastructure.vfs.dispose();
        }
    });
});

describe('host application startup', () => {
    it('keeps Agent scanning out of deferred boot and initializes on first asynchronous use', async () => {
        const initialize = vi.spyOn(VFSAgentService.prototype, 'init');
        const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web',
            startupMode: 'interactive', digitalTwinAutoStart: false });
        try {
            expect(initialize).not.toHaveBeenCalled();
            expect(await runtime.agentService.getAgents()).not.toHaveLength(0);
            expect(initialize).toHaveBeenCalledOnce();
        } finally { await runtime.dispose(); initialize.mockRestore(); }
    });

    it('initializes the repository and Kernel while directory preferences are still loading', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const initialize = DirectoryMountService.prototype.init;
        const directory = vi.spyOn(DirectoryMountService.prototype, 'init').mockImplementation(async function () {
            await gate; await initialize.call(this);
        });
        const repository = vi.spyOn(SessionRepository.prototype, 'init');
        const kernel = vi.spyOn(Kernel.prototype, 'initialize');
        const pending = createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web',
            startupMode: 'interactive', digitalTwinAutoStart: false });
        try {
            await vi.waitFor(() => expect(kernel).toHaveBeenCalled());
            expect(directory).toHaveBeenCalled();
            expect(repository).toHaveBeenCalled();
            release();
            const runtime = await pending;
            await runtime.dispose();
        } finally {
            release(); await pending.then(runtime => runtime.dispose()).catch(() => {});
            directory.mockRestore(); repository.mockRestore(); kernel.mockRestore();
        }
    });

    it('defers remote configuration refresh until background startup', async () => {
        const refresh = vi.spyOn(ProjectRemoteMountService.prototype, 'refreshMCPConnections');
        const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web',
            startupMode: 'interactive', digitalTwinAutoStart: false,
            remoteSourceProvider: { setCredential() {}, dispose: async () => {}, open: async () => { throw new Error('not connected'); } } });
        try {
            await runtime.llmDriver.ensureReady();
            expect(refresh).not.toHaveBeenCalled();
            runtime.startBackground?.();
            await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        } finally { await runtime.dispose(); refresh.mockRestore(); }
    });

    it('keeps the host available when background reconciliation fails and rejects that Session on access', async () => {
        const recovered = vi.fn();
        const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
            kernelPlatform: {
                configure: headless => {
                    vi.spyOn(headless.kernel, 'listSessions').mockImplementation(async function* () { yield { id: 'free' } as never; });
                    vi.spyOn(headless.kernel, 'recoverSession').mockImplementation(recovered);
                },
                beforeSessionRecovery: async () => { throw new Error('workspace recovery refused'); },
            },
        });
        try {
            expect(await runtime.vfs.openFileSystem('/')).toBeDefined();
            expect(recovered).not.toHaveBeenCalled();
        } finally { await runtime.dispose(); }
    });

    it('awaits host binding with initialized file services before starting Session recovery', async () => {
        let bound: ApplicationPlatformServices | undefined;
        let bindingComplete = false;
        const recovered = vi.fn();
        const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli',
            kernelPlatform: { configure: async (headless, services) => {
                bound = services;
                expect(await services.directoryMounts.processMounts('unconfigured')).toEqual([]);
                const list = headless.kernel.listSessions.bind(headless.kernel);
                vi.spyOn(headless.kernel, 'listSessions').mockImplementation(async function* () {
                    expect(bindingComplete).toBe(true);
                    recovered();
                    yield* list();
                });
                await Promise.resolve();
                bindingComplete = true;
            } },
        });
        try {
            expect(recovered).toHaveBeenCalled();
            expect(bound?.sessionFiles).toBe(runtime.sessionFiles);
            expect(bound?.directoryMounts).toBe(runtime.directoryMounts);
        } finally { await runtime.dispose(); }
    });

    it('starts without browser globals and disposes its owned filesystem', async () => {
        const progress: string[] = [];
        const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', onProgress: message => progress.push(message) });
        try {
            expect(progress).toContain('初始化核心服务…');
            expect(await runtime.agentService.getConnections()).not.toHaveLength(0);
        } finally {
            await runtime.dispose();
        }
        await expect(runtime.vfs.openFileSystem('/')).rejects.toThrow();
    });

    it('lets a reload with the same owner token take over its Sessions but keeps other windows out', async () => {
        const backend = new MemoryBackend();
        const options = { backend, ownerKind: 'cli' as const, sessionOwnerToken: 'window-token', digitalTwinAutoStart: false };
        const replaced = await createApplicationRuntime(options);
        const sessionId = await replaced.sessionRepository.createSession('reload');
        // The replaced page is not disposed: its leases outlive it exactly like a page reload.
        const reloaded = await createApplicationRuntime(options);
        const otherWindow = await createApplicationRuntime({ ...options, sessionOwnerToken: 'other-window' });
        try {
            await expect(reloaded.sessionRepository.ensureSession(sessionId, 'reload')).resolves.toBe(sessionId);
            await expect(otherWindow.sessionRepository.ensureSession(sessionId, 'reload'))
                .rejects.toThrow(/owned by another host/);
        } finally {
            await Promise.all([replaced.dispose(), reloaded.dispose(), otherWindow.dispose()]);
        }
    });
});

it('isolates conversation managers and prompt history across runtime disposal', async () => {
    const policy = { systemPrompt: ['First host'], maxExchanges: 7 };
    const first = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', directAgentPolicy: policy });
    const second = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli' });
    try {
        policy.systemPrompt[0] = 'Changed'; policy.maxExchanges = 1;
        expect(first.sessionManager.getDirectAgentPolicy()).toEqual({ systemPrompt: ['First host'], maxExchanges: 7 });
        expect(second.sessionManager.getDirectAgentPolicy().maxExchanges).toBe(50);
        expect(second.sessionManager.getDirectAgentPolicy().systemPrompt[0]).toContain('Execute the user request');
        expect(first.sessionManager).not.toBe(second.sessionManager);
        expect(first.sessionManager.promptHistory).not.toBe(second.sessionManager.promptHistory);
        await first.sessionManager.promptHistory!.add('first host');
        await second.sessionManager.promptHistory!.add('second host');
        expect((await first.sessionManager.getRecentPrompts(10)).map(entry => entry.text)).toEqual(['first host']);
        expect((await second.sessionManager.getRecentPrompts(10)).map(entry => entry.text)).toEqual(['second host']);
        await first.dispose();
        await second.sessionManager.promptHistory!.add('still active');
        expect((await second.sessionManager.getRecentPrompts(10)).map(entry => entry.text)).toContain('still active');
        expect(second.sessionManager.getStatus()).toBe('unbound');
    } finally { await second.dispose(); await first.dispose(); }
});
