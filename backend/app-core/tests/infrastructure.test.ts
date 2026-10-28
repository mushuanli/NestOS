import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm/core';
import { createInfrastructure } from '../src/runtime/infrastructure';

afterEach(() => vi.restoreAllMocks());

describe('application infrastructure ownership', () => {
    it('returns initialized layout and devices with explicit cleanup ownership', async () => {
        const close = vi.fn();
        const infrastructure = await createInfrastructure({
            backend: new MemoryBackend(),
            additionalMounts: [{ path: '/extra', backend: new MemoryBackend() }],
            codexTransport: { close },
            mcp: { stdioTransport: false },
        });
        try {
            expect(infrastructure.vfs.devices.isFrozen()).toBe(true);
            expect(infrastructure.llmDriver.supportsMCPStdio()).toBe(false);
            for (const path of ['/run', '/extra', '/home/admin/projects', '/home/admin/.config']) {
                expect(await infrastructure.systemFS.driver.getNode(path)).not.toBeNull();
            }
            expect(await infrastructure.systemFS.driver.exists('/home/admin/chats')).toBe(false);
            infrastructure.logIO('test');
            expect(infrastructure.vfs.ioStats.stat).toBe(0);
            expect(close).not.toHaveBeenCalled();
        } finally {
            await infrastructure.closeCodexTransport?.();
            await infrastructure.vfs.dispose();
        }
        expect(close).toHaveBeenCalledOnce();
    });

    it('defers device materialization until namespace access and merges concurrent preparation', async () => {
        const nodes = vi.spyOn(LLMDeviceDriver.prototype, 'createDeviceNodes');
        const infrastructure = await createInfrastructure({ backend: new MemoryBackend(), llmInitialization: 'background', deviceInitialization: 'on-demand', preloadDirectories: [] });
        try {
            await infrastructure.llmDriver.ensureReady();
            const lazy = typeof (infrastructure.vfs.devices as { ready?: unknown }).ready === 'function';
            expect(nodes).toHaveBeenCalledTimes(lazy ? 0 : 1);
            expect(await infrastructure.systemFS.driver.getNode('/etc')).not.toBeNull();
            expect(nodes).toHaveBeenCalledTimes(lazy ? 0 : 1);
            const [first, second] = await Promise.all([
                infrastructure.systemFS.driver.getChildren('/dev/llm/connection'),
                infrastructure.systemFS.driver.getChildren('/dev/llm/connection'),
            ]);
            expect(first.length).toBeGreaterThan(0);
            expect(second.map(node => node.path)).toEqual(first.map(node => node.path));
            expect(nodes).toHaveBeenCalledOnce();
        } finally { await infrastructure.vfs.dispose(); }
    });

    it.each(['init', 'createDeviceNodes'] as const)('releases acquired resources when %s fails', async method => {
        const failure = new Error('device initialization failed');
        vi.spyOn(LLMDeviceDriver.prototype, method).mockRejectedValueOnce(failure);
        const backend = new MemoryBackend();
        const closed = vi.spyOn(backend, 'close');
        const close = vi.fn();
        await expect(createInfrastructure({ backend, codexTransport: { close } })).rejects.toBe(failure);
        expect(close).toHaveBeenCalledOnce();
        expect(closed).toHaveBeenCalledOnce();
    });

    it('still disposes the VFS and preserves both errors when transport cleanup fails', async () => {
        const failure = new Error('device initialization failed');
        const cleanupFailure = new Error('transport cleanup failed');
        vi.spyOn(LLMDeviceDriver.prototype, 'init').mockRejectedValueOnce(failure);
        const backend = new MemoryBackend();
        const closed = vi.spyOn(backend, 'close');
        const close = vi.fn().mockRejectedValue(cleanupFailure);
        await expect(createInfrastructure({ backend, codexTransport: { close } })).rejects.toMatchObject({
            errors: [failure, cleanupFailure],
        });
        expect(closed).toHaveBeenCalledOnce();
    });
});
