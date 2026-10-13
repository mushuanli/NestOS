import { TwinSafeLlmLogger } from '../digital-twin/llm-logger';
import { createMindosLlmPresets, firstChatModelConnection } from '@itookit/kernel-adapters/llm/presets';
import { createVFS, MemoryBackend, type IFileSystem, type IStorageBackend, type IVFSManager, type MountOptions } from '@itookit/vfs-core';
import { LLMDeviceDriver, type CodexAppServerTransport } from '@itookit/kernel-adapters/llm/core';
import { t, traceBoot, createModuleLogger } from '@itookit/common';
import { type ILLMLogger } from '@itookit/driver-llm/contracts';

export interface ApplicationInfrastructureOptions {
    backend: IStorageBackend;
    llmInitialization?: 'before-ready' | 'background';
    deviceInitialization?: 'before-ready' | 'on-demand';
    preloadDirectories?: readonly string[];
    additionalMounts?: Array<{ path: string; backend: IStorageBackend; options?: MountOptions }>;
    llmLogger?: ILLMLogger;
    mcp?: import('@itookit/kernel-adapters/llm/core').MCPConnectionOptions;
    codexTransport?: CodexAppServerTransport;
    onProgress?(message: string): void;
}

export interface ApplicationInfrastructure {
    vfs: IVFSManager;
    /** Root filesystem view shared by every Session-independent service. */
    systemFS: IFileSystem;
    llmDriver: LLMDeviceDriver;
    /** Dump and reset VFS I/O counters, for identifying redundant reads/writes. */
    logIO(label: string): void;
    /** Close the injected Codex transport, when the host provided one. */
    closeCodexTransport?(): void | Promise<void>;
}

/**
 * Build the platform-independent stores every later step depends on: the VFS (with the
 * `/run` scratch mount) and the LLM device driver registered as a VFS device.
 * Hosts still own the cleanup order: the returned VFS must be disposed last.
 */
export async function createInfrastructure(options: ApplicationInfrastructureOptions): Promise<ApplicationInfrastructure> {
    const logStep = (label: string) => { console.log(`[Boot] ${label}`); options.onProgress?.(label); };
    logStep(t('boot.filesystem'));
    const { manager: vfs } = await traceBoot('createVFS', () => createVFS({
        rootBackend: options.backend,
        additionalMounts: [...(options.additionalMounts ?? []), { path: '/run', backend: new MemoryBackend() }],
    }));
    const logIO = (label: string): void => {
        try {
            const stats = vfs.ioStats;
            console.log(`[Boot]   ↳ IO after ${label}: stat=${stats.stat} list=${stats.list} read=${stats.read} write=${stats.write} mkdir=${stats.mkdir} delete=${stats.delete} rename=${stats.rename}`);
            vfs.resetIOStats();
        } catch { /* ignore */ }
    };
    try {
        return await initializeDevices(options, vfs, logStep, logIO);
    } catch (error) {
        const errors: unknown[] = [error];
        for (const close of [() => options.codexTransport?.close?.(), () => vfs.dispose()]) {
            try { await close(); } catch (cleanupError) { errors.push(cleanupError); }
        }
        if (errors.length > 1) throw new AggregateError(errors, 'Infrastructure startup and cleanup failed');
        throw error;
    }
}

async function initializeDevices(options: ApplicationInfrastructureOptions, vfs: IVFSManager,
    logStep: (label: string) => void, logIO: (label: string) => void): Promise<ApplicationInfrastructure> {
    logIO('createVFS');

    logStep(t('boot.llmDriver'));
    const llmDriver = new LLMDeviceDriver(vfs, {
        presets: createMindosLlmPresets(), providerConnectionPolicy: firstChatModelConnection,
        llmLogger: options.llmLogger ? new TwinSafeLlmLogger(options.llmLogger) : undefined, mcp: { clientInfo: { name: 'mindos', version: '1.0.0' }, logger: createModuleLogger('llm:mcp'), ...options.mcp }, codexTransport: options.codexTransport,
    });
    vfs.devices.register(llmDriver);
    vfs.devices.freeze();
    const initialization = () => traceBoot('llmDriver.init', () => llmDriver.init());
    if (options.llmInitialization === 'background') {
        void initialization().catch(error => console.error('[Boot] LLM initialization failed', error));
    } else await initialization();
    if (options.deviceInitialization === 'on-demand' && typeof (vfs.devices as { ready?: unknown }).ready !== 'function')
        throw new Error('On-demand devices require VFS readiness support');
    if (options.deviceInitialization !== 'on-demand') {
        await traceBoot('llmDriver.createDeviceNodes', async () => {
            await llmDriver.ensureReady(); await llmDriver.createDeviceNodes();
        });
    }
    logIO('LLM driver');
    const directories = options.preloadDirectories ?? ['/home/admin/chats', '/home/admin/notes', '/home/admin/projects', '/home/admin/.config'];
    await Promise.all(directories.map(path => vfs.openFileSystem(path)));
    const systemFS = await vfs.openFileSystem('/');
    return {
        vfs, systemFS, llmDriver, logIO,
        ...(options.codexTransport?.close ? { closeCodexTransport: () => options.codexTransport!.close!() } : {}),
    };
}
